package com.kvspt.kvdesk

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.Point
import android.hardware.display.DisplayManager
import android.media.projection.MediaProjection
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.provider.MediaStore
import android.util.DisplayMetrics
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import io.socket.client.Ack
import io.socket.client.IO
import io.socket.client.Socket
import org.json.JSONArray
import org.json.JSONObject
import org.webrtc.DataChannel
import org.webrtc.DefaultVideoDecoderFactory
import org.webrtc.DefaultVideoEncoderFactory
import org.webrtc.EglBase
import org.webrtc.IceCandidate
import org.webrtc.MediaConstraints
import org.webrtc.PeerConnection
import org.webrtc.PeerConnectionFactory
import org.webrtc.RtpSender
import org.webrtc.SdpObserver
import org.webrtc.ScreenCapturerAndroid
import org.webrtc.SessionDescription
import org.webrtc.SurfaceTextureHelper
import org.webrtc.VideoSource
import org.webrtc.VideoTrack
import java.io.OutputStream
import java.nio.ByteBuffer
import java.util.concurrent.ConcurrentHashMap
import kotlin.math.max
import kotlin.math.min

data class HostUiState(val status: String = "Offline", val id: String? = null, val capturing: Boolean = false)

class DeskService : Service() {
    private lateinit var store: DeskStore
    private val main = Handler(Looper.getMainLooper())
    private var socket: Socket? = null
    private var egl: EglBase? = null
    private var capturer: ScreenCapturerAndroid? = null
    private var videoSource: VideoSource? = null
    private var videoTrack: VideoTrack? = null
    private var factory: PeerConnectionFactory? = null
    private val sessions = ConcurrentHashMap<String, HostSession>()
    private val requests = ConcurrentHashMap<String, JSONObject>()
    private val requestTimeouts = ConcurrentHashMap<String, Runnable>()
    private val files = ConcurrentHashMap<String, OutputStream>()
    private val fileTransferIds = ConcurrentHashMap<String, String>()
    private var isConnecting = false

    private data class HostSession(
        val id: String,
        val peer: PeerConnection,
        val ctl: DataChannel,
        val file: DataChannel,
        val permissions: JSONObject,
        val pendingCandidates: MutableList<IceCandidate> = mutableListOf()
    )

    override fun onCreate() {
        super.onCreate()
        store = DeskStore(applicationContext)
        createChannels()
        startForegroundCompat(serviceNotification(), ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        initializeWebRtc()
        connectSocket()
        publishState("Connecting")
        if (capturer == null) postCaptureNotification()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP -> {
                stopSelf()
                return START_NOT_STICKY
            }
            ACTION_CAPTURE -> {
                val resultCode = intent.getIntExtra(EXTRA_RESULT_CODE, 0)
                val permissionData = intent.getParcelableExtra<Intent>(EXTRA_PERMISSION_DATA)
                if (resultCode != 0 && permissionData != null) beginCapture(resultCode, permissionData)
            }
            ACTION_ACCEPT -> answerPending(intent.getStringExtra(EXTRA_SESSION_ID).orEmpty(), true)
            ACTION_REJECT -> answerPending(intent.getStringExtra(EXTRA_SESSION_ID).orEmpty(), false, "rejected")
        }
        return START_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun createChannels() {
        if (Build.VERSION.SDK_INT < 26) return
        val manager = getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(NotificationChannel(CHANNEL_SERVICE, "Bainsla Remote status", NotificationManager.IMPORTANCE_LOW))
        manager.createNotificationChannel(NotificationChannel(CHANNEL_REQUEST, "Bainsla Remote requests", NotificationManager.IMPORTANCE_HIGH))
    }

    private fun startForegroundCompat(notification: Notification, type: Int) {
        if (Build.VERSION.SDK_INT >= 29) {
            var types = type
            if (Build.VERSION.SDK_INT >= 34 && capturer != null) {
                types = types or ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION
            }
            startForeground(NOTIFICATION_ID, notification, types)
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
    }

    private fun serviceNotification(): Notification {
        val id = store.deviceId?.chunked(3)?.joinToString(" ") ?: "Connecting"
        val open = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        return NotificationCompat.Builder(this, CHANNEL_SERVICE)
            .setSmallIcon(android.R.drawable.stat_sys_upload_done)
            .setContentTitle("Bainsla Remote is online")
            .setContentText(if (capturer == null) "ID $id · Tap to allow screen sharing" else "ID $id · Screen sharing ready")
            .setContentIntent(open)
            .setOngoing(true)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .build()
    }

    private fun publishState(status: String) {
        val current = HostUiState(status, store.deviceId, capturer != null)
        hostState.value = current
        if (status == "Online" || status == "Connecting") {
            startForegroundCompat(serviceNotification(), ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        }
    }

    private fun connectSocket() {
        if (isConnecting) return
        isConnecting = true
        val base = store.serverUrl.trimEnd('/')
        val parsed = android.net.Uri.parse(base)
        val path = parsed.path.orEmpty().trimEnd('/')
        val origin = buildString {
            append(parsed.scheme).append("://").append(parsed.host)
            if (parsed.port >= 0) append(':').append(parsed.port)
        }
        val options = IO.Options().apply {
            this.path = "${path}/socket.io".ifEmpty { "/socket.io" }
            reconnection = true
            reconnectionAttempts = Int.MAX_VALUE
            reconnectionDelay = 1000
            reconnectionDelayMax = 10_000
            timeout = 15_000
        }
        val client = runCatching { IO.socket(origin, options) }.getOrElse {
            isConnecting = false
            publishState("Offline")
            main.postDelayed({ connectSocket() }, 5000)
            return
        }
        socket = client
        client.on(Socket.EVENT_CONNECT) {
            val hello = JSONObject()
                .put("name", store.deviceName)
                .put("platform", "android")
                .put("os", "Android ${Build.VERSION.RELEASE}")
                .put("version", BuildConfig.VERSION_NAME)
                .put("role", "agent")
            store.deviceId?.let { hello.put("id", it).put("secret", store.deviceSecret) }
            client.emit("agent:hello", hello, Ack { args ->
                main.post {
                    val result = args.firstOrNull() as? JSONObject
                    if (result?.optBoolean("ok") != true) {
                        publishState("Offline")
                        return@post
                    }
                    val id = result.optString("id")
                    val secret = result.optString("secret", store.deviceSecret.orEmpty())
                    if (id.isNotBlank() && secret.isNotBlank()) store.saveDevice(id, secret)
                    publishState("Online")
                }
            })
        }
        client.on(Socket.EVENT_DISCONNECT) {
            isConnecting = false
            main.post { publishState("Connecting") }
        }
        client.on(Socket.EVENT_CONNECT_ERROR) {
            isConnecting = false
            main.post { publishState("Connecting") }
        }
        client.on("agent:replaced") {
            main.post { publishState("Offline") }
        }
        client.on("agent:blocked") {
            main.post { publishState("Blocked") }
        }
        client.on("session:request") { args ->
            val request = args.firstOrNull() as? JSONObject ?: return@on
            main.post { onRequest(request) }
        }
        client.on("session:accepted") { args ->
            val data = args.firstOrNull() as? JSONObject ?: return@on
            main.post { if (requests.containsKey(data.optString("sessionId"))) createSession(data) }
        }
        client.on("session:rejected") { args ->
            val data = args.firstOrNull() as? JSONObject ?: return@on
            clearRequest(data.optString("sessionId"))
        }
        client.on("signal") { args ->
            val data = args.firstOrNull() as? JSONObject ?: return@on
            main.post { receiveSignal(data) }
        }
        client.on("session:kill") { args ->
            val data = args.firstOrNull() as? JSONObject ?: return@on
            main.post { closeSession(data.optString("sessionId")) }
        }
        client.connect()
    }

    private fun initializeWebRtc() {
        PeerConnectionFactory.initialize(
            PeerConnectionFactory.InitializationOptions.builder(this).createInitializationOptions()
        )
        egl = EglBase.create()
        factory = PeerConnectionFactory.builder()
            .setVideoEncoderFactory(DefaultVideoEncoderFactory(egl!!.eglBaseContext, true, true))
            .setVideoDecoderFactory(DefaultVideoDecoderFactory(egl!!.eglBaseContext))
            .createPeerConnectionFactory()
    }

    private fun beginCapture(resultCode: Int, permissionData: Intent) {
        if (capturer != null) return
        val currentEgl = egl ?: return
        val source = factory?.createVideoSource(true) ?: return
        val projectionCapturer = ScreenCapturerAndroid(permissionData, object : MediaProjection.Callback() {
            override fun onStop() {
                main.post {
                    capturer = null
                    videoTrack = null
                    videoSource = null
                    hostState.value = HostUiState(hostState.value.status, store.deviceId, false)
                    postCaptureNotification()
                }
            }
        })
        val helper = SurfaceTextureHelper.create("BainslaRemoteCapture", currentEgl.eglBaseContext)
        projectionCapturer.initialize(helper, this, source.capturerObserver)
        val size = captureSize()
        try {
            capturer = projectionCapturer
            videoSource = source
            startForegroundCompat(serviceNotification(), ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
            projectionCapturer.startCapture(size.first, size.second, 20)
            videoTrack = factory?.createVideoTrack("kvdesk-screen", source)?.apply { setEnabled(true) }
            if (Build.VERSION.SDK_INT >= 29) {
                startForegroundCompat(serviceNotification(), ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC or ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION)
            }
            getSystemService(NotificationManager::class.java).cancel(CAPTURE_NOTIFICATION_ID)
            hostState.value = HostUiState(hostState.value.status, store.deviceId, true)
            getSystemService(NotificationManager::class.java).notify(NOTIFICATION_ID, serviceNotification())
        } catch (error: Exception) {
            runCatching { projectionCapturer.stopCapture() }
            capturer = null
            videoSource = null
            postCaptureNotification()
        }
    }

    private fun captureSize(): Pair<Int, Int> {
        val display = getSystemService(DisplayManager::class.java).getDisplay(android.view.Display.DEFAULT_DISPLAY)
        val metrics = DisplayMetrics()
        @Suppress("DEPRECATION")
        display?.getRealMetrics(metrics)
        val width = max(2, metrics.widthPixels)
        val height = max(2, metrics.heightPixels)
        val scale = min(1.0, 1280.0 / max(width, height))
        val outWidth = max(2, ((width * scale).toInt() / 2) * 2)
        val outHeight = max(2, ((height * scale).toInt() / 2) * 2)
        return outWidth to outHeight
    }

    private fun onRequest(request: JSONObject) {
        val sessionId = request.optString("sessionId")
        if (sessionId.isBlank()) return
        if (capturer == null || videoTrack == null) {
            postCaptureNotification()
            answer(request, false, "Screen sharing permission is required. Tap the Bainsla Remote notification and choose Start now.")
            return
        }
        val password = request.optString("password")
        val salt = store.unattendedSalt
        val hash = store.unattendedHash
        if (password.isNotEmpty() && salt != null && hash != null) {
            Thread {
                val matches = runCatching { PasswordHasher.verify(password, salt, hash) }.getOrDefault(false)
                main.post {
                    if (matches) answer(request, true, mode = "unattended")
                    else answer(request, false, "bad_password")
                }
            }.start()
            return
        }
        if (password.isNotEmpty()) {
            answer(request, false, "bad_password")
            return
        }
        requests[sessionId] = request
        val timeout = Runnable { answerPending(sessionId, false, "timeout") }
        requestTimeouts[sessionId] = timeout
        main.postDelayed(timeout, 30_000)
        showRequestNotification(request)
    }

    private fun answer(request: JSONObject, accept: Boolean, reason: String = "rejected", mode: String? = null) {
        val sessionId = request.optString("sessionId")
        if (accept) requests[sessionId] = request
        val permissions = JSONObject()
            .put("control", DeskAccessibilityService.isEnabled(this))
            .put("clipboard", true)
            .put("files", true)
        socket?.emit("session:answer", JSONObject()
            .put("sessionId", sessionId)
            .put("accept", accept)
            .put("reason", reason)
            .put("mode", mode)
            .put("permissions", permissions))
        if (!accept) clearRequest(sessionId)
        else getSystemService(NotificationManager::class.java).cancel(requestNotificationId(sessionId))
    }

    private fun answerPending(sessionId: String, accept: Boolean, reason: String = "rejected") {
        val request = requests[sessionId] ?: return
        requestTimeouts.remove(sessionId)?.let(main::removeCallbacks)
        answer(request, accept, reason, if (accept) "attended" else null)
    }

    private fun clearRequest(sessionId: String) {
        requests.remove(sessionId)
        requestTimeouts.remove(sessionId)?.let(main::removeCallbacks)
        getSystemService(NotificationManager::class.java).cancel(requestNotificationId(sessionId))
    }

    private fun showRequestNotification(request: JSONObject) {
        val sessionId = request.optString("sessionId")
        val actions = listOf("Accept" to ACTION_ACCEPT, "Reject" to ACTION_REJECT)
        val builder = NotificationCompat.Builder(this, CHANNEL_REQUEST)
            .setSmallIcon(android.R.drawable.stat_sys_warning)
            .setContentTitle("Remote connection request")
            .setContentText("${request.optString("viewerName", "Viewer")} wants to connect")
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setAutoCancel(true)
        actions.forEachIndexed { index, (title, action) ->
            val intent = Intent(this, DeskService::class.java)
                .setAction(action)
                .putExtra(EXTRA_SESSION_ID, sessionId)
            val pending = PendingIntent.getService(
                this, requestNotificationId(sessionId) + index, intent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            )
            builder.addAction(0, title, pending)
        }
        getSystemService(NotificationManager::class.java).notify(requestNotificationId(sessionId), builder.build())
    }

    private fun postCaptureNotification() {
        val open = PendingIntent.getActivity(
            this, 991, Intent(this, MainActivity::class.java)
                .putExtra(MainActivity.EXTRA_CAPTURE_PROMPT, true)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val notification = NotificationCompat.Builder(this, CHANNEL_REQUEST)
            .setSmallIcon(android.R.drawable.stat_sys_warning)
            .setContentTitle("Tap to allow screen sharing")
            .setContentText("Open Bainsla Remote and approve the screen-capture prompt to accept remote sessions.")
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setAutoCancel(true)
            .setContentIntent(open)
            .build()
        getSystemService(NotificationManager::class.java).notify(CAPTURE_NOTIFICATION_ID, notification)
    }

    private fun requestNotificationId(id: String) = id.hashCode() and 0x7fffffff

    private fun createSession(data: JSONObject) {
        val id = data.optString("sessionId")
        if (id.isBlank() || sessions.containsKey(id)) return
        clearRequest(id)
        val server = data.optJSONArray("iceServers") ?: JSONArray()
        val iceServers = mutableListOf<PeerConnection.IceServer>()
        for (index in 0 until server.length()) {
            val item = server.optJSONObject(index) ?: continue
            val urls = item.opt("urls")
            val urlList = when (urls) {
                is JSONArray -> (0 until urls.length()).map { urls.optString(it) }
                is String -> listOf(urls)
                else -> emptyList()
            }
            val username = item.optString("username")
            val credential = item.optString("credential")
            urlList.filter { it.isNotBlank() }.forEach { url ->
                val builder = PeerConnection.IceServer.builder(url)
                if (username.isNotEmpty()) builder.setUsername(username)
                if (credential.isNotEmpty()) builder.setPassword(credential)
                iceServers += builder.createIceServer()
            }
        }
        val config = PeerConnection.RTCConfiguration(iceServers).apply {
            sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN
        }
        val peer = factory?.createPeerConnection(config, peerObserver(id)) ?: return
        val track = videoTrack ?: return
        peer.addTrack(track, listOf("kvdesk-screen"))
        val ctl = peer.createDataChannel("ctl", DataChannel.Init())
        val file = peer.createDataChannel("file", DataChannel.Init())
        val permissions = data.optJSONObject("permissions") ?: JSONObject()
        val session = HostSession(id, peer, ctl, file, permissions)
        sessions[id] = session
        observeControl(session)
        observeFile(session)
        peer.createOffer(object : SdpObserver {
            override fun onCreateSuccess(description: SessionDescription) {
                peer.setLocalDescription(object : SdpObserver {
                    override fun onSetSuccess() {
                        val local = peer.localDescription ?: return
                        socket?.emit("signal", JSONObject()
                            .put("sessionId", id)
                            .put("data", JSONObject().put("sdp", JSONObject()
                                .put("type", local.type.canonicalForm())
                                .put("sdp", local.description))))
                    }
                    override fun onCreateSuccess(description: SessionDescription?) {}
                    override fun onCreateFailure(error: String?) { endWithError(id, error) }
                    override fun onSetFailure(error: String?) { endWithError(id, error) }
                }, description)
            }
            override fun onSetSuccess() {}
            override fun onCreateFailure(error: String?) { endWithError(id, error) }
            override fun onSetFailure(error: String?) { endWithError(id, error) }
        }, MediaConstraints())
    }

    private fun peerObserver(id: String) = object : PeerConnection.Observer {
        override fun onSignalingChange(state: PeerConnection.SignalingState?) {}
        override fun onIceConnectionChange(state: PeerConnection.IceConnectionState?) {
            if (state == PeerConnection.IceConnectionState.FAILED) endWithError(id, "ICE failed")
        }
        override fun onIceConnectionReceivingChange(receiving: Boolean) {}
        override fun onIceGatheringChange(state: PeerConnection.IceGatheringState?) {}
        override fun onIceCandidate(candidate: IceCandidate?) {
            candidate ?: return
            val json = JSONObject()
                .put("candidate", candidate.sdp)
                .put("sdpMid", candidate.sdpMid)
                .put("sdpMLineIndex", candidate.sdpMLineIndex)
            socket?.emit("signal", JSONObject().put("sessionId", id).put("data", JSONObject().put("candidate", json)))
        }
        override fun onIceCandidatesRemoved(candidates: Array<out IceCandidate>?) {}
        override fun onAddStream(stream: org.webrtc.MediaStream?) {}
        override fun onRemoveStream(stream: org.webrtc.MediaStream?) {}
        override fun onDataChannel(channel: DataChannel?) {}
        override fun onRenegotiationNeeded() {}
        override fun onAddTrack(receiver: org.webrtc.RtpReceiver?, streams: Array<out org.webrtc.MediaStream>?) {}
        override fun onConnectionChange(newState: PeerConnection.PeerConnectionState?) {
            if (newState == PeerConnection.PeerConnectionState.FAILED || newState == PeerConnection.PeerConnectionState.CLOSED) {
                if (newState == PeerConnection.PeerConnectionState.FAILED) endWithError(id, "Connection failed")
            }
        }
    }

    private fun receiveSignal(payload: JSONObject) {
        val id = payload.optString("sessionId")
        val session = sessions[id] ?: return
        val data = payload.optJSONObject("data") ?: return
        val sdp = data.optJSONObject("sdp")
        if (sdp != null) {
            val description = SessionDescription(
                SessionDescription.Type.fromCanonicalForm(sdp.optString("type")),
                sdp.optString("sdp")
            )
            session.peer.setRemoteDescription(object : SdpObserver {
                override fun onSetSuccess() {
                    session.pendingCandidates.toList().forEach(session.peer::addIceCandidate)
                    session.pendingCandidates.clear()
                }
                override fun onCreateSuccess(description: SessionDescription?) {}
                override fun onCreateFailure(error: String?) { endWithError(id, error) }
                override fun onSetFailure(error: String?) { endWithError(id, error) }
            }, description)
        } else {
            val candidate = data.optJSONObject("candidate") ?: return
            val ice = IceCandidate(
                candidate.optString("sdpMid", "0"),
                candidate.optInt("sdpMLineIndex", 0),
                candidate.optString("candidate")
            )
            if (session.peer.remoteDescription != null) session.peer.addIceCandidate(ice)
            else session.pendingCandidates += ice
        }
    }

    private fun observeControl(session: HostSession) {
        session.ctl.registerObserver(object : DataChannel.Observer {
            override fun onBufferedAmountChange(previousAmount: Long) {}
            override fun onStateChange() {
                if (session.ctl.state() == DataChannel.State.OPEN) {
                    sendCtl(session, JSONObject().put("t", "screens").put("list", JSONArray().put(
                        JSONObject().put("id", "0").put("name", "This phone").put("w", captureSize().first)
                            .put("h", captureSize().second).put("primary", true)
                    )).put("current", "0"))
                    sendCtl(session, JSONObject().put("t", "perm")
                        .put("control", session.permissions.optBoolean("control", false))
                        .put("clipboard", true).put("files", true))
                }
            }
            override fun onMessage(buffer: DataChannel.Buffer) {
                if (buffer.binary) return
                val bytes = ByteArray(buffer.data.remaining())
                buffer.data.get(bytes)
                val message = runCatching { JSONObject(bytes.toString(Charsets.UTF_8)) }.getOrNull() ?: return
                handleControl(session, message)
            }
        })
    }

    private fun handleControl(session: HostSession, message: JSONObject) {
        when (message.optString("t")) {
            "mm", "md", "mu", "wh", "kd", "ku", "combo", "nav" ->
                if (session.permissions.optBoolean("control", false)) DeskAccessibilityService.dispatch(message)
            "clip" -> {
                val clipboard = getSystemService(Context.CLIPBOARD_SERVICE) as android.content.ClipboardManager
                clipboard.setPrimaryClip(android.content.ClipData.newPlainText("Bainsla Remote", message.optString("text")))
            }
            "chat" -> {
                val notification = NotificationCompat.Builder(this, CHANNEL_REQUEST)
                    .setSmallIcon(android.R.drawable.stat_notify_chat)
                    .setContentTitle("Bainsla Remote message")
                    .setContentText(message.optString("text").take(120))
                    .setAutoCancel(true)
                    .build()
                getSystemService(NotificationManager::class.java).notify(message.optString("text").hashCode(), notification)
            }
            "quality" -> applyQuality(session, message.optString("q", "balanced"))
            "fs" -> if (session.permissions.optBoolean("files", false)) beginIncomingFile(session, message)
            "fe" -> finishIncomingFile(session, message.optString("id"))
        }
    }

    private fun applyQuality(session: HostSession, quality: String) {
        val sender = session.peer.senders.firstOrNull() ?: return
        val parameters = sender.parameters
        val bitrate = when (quality) {
            "high" -> 8_000_000
            "low" -> 1_000_000
            else -> 3_000_000
        }
        parameters.encodings.forEach {
            it.maxBitrateBps = bitrate
            it.maxFramerate = if (quality == "high") 30 else if (quality == "low") 15 else 20
        }
        sender.parameters = parameters
    }

    private fun observeFile(session: HostSession) {
        session.file.registerObserver(object : DataChannel.Observer {
            override fun onBufferedAmountChange(previousAmount: Long) {}
            override fun onStateChange() {}
            override fun onMessage(buffer: DataChannel.Buffer) {
                if (!buffer.binary) return
                val bytes = ByteArray(buffer.data.remaining())
                buffer.data.get(bytes)
                val stream = files[session.id] ?: return
                runCatching { stream.write(bytes) }
            }
        })
    }

    private fun beginIncomingFile(session: HostSession, message: JSONObject) {
        val id = message.optString("id")
        val name = message.optString("name", "kvdesk-download")
        if (id.isBlank()) return
        fileTransferIds[session.id] = id
        runCatching {
            val uri: Uri
            if (Build.VERSION.SDK_INT >= 29) {
                val values = ContentValues().apply {
                    put(MediaStore.Downloads.DISPLAY_NAME, name)
                    put(MediaStore.Downloads.MIME_TYPE, "application/octet-stream")
                    put(MediaStore.Downloads.RELATIVE_PATH, "${Environment.DIRECTORY_DOWNLOADS}/Bainsla Remote")
                }
                uri = contentResolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)!!
                files[session.id] = contentResolver.openOutputStream(uri)!!
            } else {
                val directory = java.io.File(getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS), "Bainsla Remote").apply { mkdirs() }
                files[session.id] = java.io.FileOutputStream(java.io.File(directory, name))
            }
        }
    }

    private fun finishIncomingFile(session: HostSession, id: String) {
        if (fileTransferIds.remove(session.id) != id) return
        files.remove(session.id)?.close()
    }

    private fun sendCtl(session: HostSession, message: JSONObject) {
        if (session.ctl.state() != DataChannel.State.OPEN) return
        session.ctl.send(DataChannel.Buffer(ByteBuffer.wrap(message.toString().toByteArray()), false))
    }

    private fun endWithError(id: String, error: String?) {
        socket?.emit("session:end", JSONObject().put("sessionId", id).put("reason", error ?: "host_error"))
        closeSession(id)
    }

    private fun closeSession(id: String) {
        sessions.remove(id)?.let { session ->
            session.ctl.unregisterObserver()
            session.file.unregisterObserver()
            session.peer.close()
        }
    }

    override fun onDestroy() {
        socket?.disconnect()
        socket?.off()
        sessions.keys.toList().forEach(::closeSession)
        requestTimeouts.values.forEach(main::removeCallbacks)
        files.values.forEach { runCatching { it.close() } }
        fileTransferIds.clear()
        runCatching { capturer?.stopCapture() }
        capturer?.dispose()
        videoTrack?.dispose()
        videoSource?.dispose()
        factory?.dispose()
        egl?.release()
        hostState.value = HostUiState("Offline", store.deviceId, false)
        super.onDestroy()
    }

    companion object {
        const val ACTION_START = "com.kvspt.kvdesk.START"
        const val ACTION_STOP = "com.kvspt.kvdesk.STOP"
        const val ACTION_CAPTURE = "com.kvspt.kvdesk.CAPTURE"
        const val ACTION_ACCEPT = "com.kvspt.kvdesk.ACCEPT"
        const val ACTION_REJECT = "com.kvspt.kvdesk.REJECT"
        const val EXTRA_SESSION_ID = "session_id"
        const val EXTRA_RESULT_CODE = "projection_result"
        const val EXTRA_PERMISSION_DATA = "projection_data"
        const val CHANNEL_SERVICE = "kvdesk-service"
        const val CHANNEL_REQUEST = "kvdesk-request"
        const val NOTIFICATION_ID = 3015
        const val CAPTURE_NOTIFICATION_ID = 3016
        val hostState = kotlinx.coroutines.flow.MutableStateFlow(HostUiState())

        fun start(context: Context) {
            ContextCompat.startForegroundService(context, Intent(context, DeskService::class.java).setAction(ACTION_START))
        }
    }
}
