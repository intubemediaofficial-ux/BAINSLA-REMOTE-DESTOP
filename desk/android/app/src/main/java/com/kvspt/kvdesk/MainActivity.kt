package com.kvspt.kvdesk

import android.app.Activity
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.media.projection.MediaProjectionManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.view.inputmethod.InputMethodManager
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.result.ActivityResultLauncher
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ContentCopy
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Switch
import androidx.compose.material3.Tab
import androidx.compose.material3.TabRow
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

private val Background = Color(0xFF0F172A)
private val Surface = Color(0xFF111827)
private val Accent = Color(0xFFEF4444)
private val Muted = Color(0xFF94A3B8)

class MainActivity : ComponentActivity() {
    private lateinit var store: DeskStore
    private lateinit var captureLauncher: ActivityResultLauncher<Intent>

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        captureLauncher = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
            if (result.resultCode != Activity.RESULT_OK || result.data == null) return@registerForActivityResult
            val intent = Intent(this, DeskService::class.java)
                .setAction(DeskService.ACTION_CAPTURE)
                .putExtra(DeskService.EXTRA_RESULT_CODE, result.resultCode)
                .putExtra(DeskService.EXTRA_PERMISSION_DATA, result.data)
            ContextCompat.startForegroundService(this, intent)
        }
        store = DeskStore(this)
        window.statusBarColor = android.graphics.Color.rgb(15, 23, 42)
        window.navigationBarColor = android.graphics.Color.rgb(15, 23, 42)
        setContent {
            MaterialTheme(colorScheme = darkColorScheme(
                primary = Accent, background = Background, surface = Surface,
                onPrimary = Color.White, onBackground = Color.White, onSurface = Color.White
            )) {
                BainslaRemoteApp(
                    store = store,
                    showCaptureOnStart = intent.getBooleanExtra(EXTRA_CAPTURE_PROMPT, false),
                    onStartService = { capture ->
                        DeskService.start(this)
                        if (capture) Handler(Looper.getMainLooper()).postDelayed({ launchCapturePermission() }, 450)
                    },
                    onStopService = { stopService(Intent(this, DeskService::class.java)) },
                    onCapturePermission = { launchCapturePermission() }
                )
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        if (intent.getBooleanExtra(EXTRA_CAPTURE_PROMPT, false)) launchCapturePermission()
    }

    private fun launchCapturePermission() {
        val manager = getSystemService(Context.MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
        captureLauncher.launch(manager.createScreenCaptureIntent())
    }

    companion object {
        const val EXTRA_CAPTURE_PROMPT = "capture_prompt"
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun BainslaRemoteApp(
    store: DeskStore,
    showCaptureOnStart: Boolean,
    onStartService: (Boolean) -> Unit,
    onStopService: () -> Unit,
    onCapturePermission: () -> Unit
) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val host by DeskService.hostState.collectAsStateWithLifecycle()
    var tab by remember { mutableStateOf(0) }
    var serverUrl by remember { mutableStateOf(store.serverUrl) }
    var deviceName by remember { mutableStateOf(store.deviceName) }
    var settingsOpen by remember { mutableStateOf(false) }
    var desks by remember { mutableStateOf(store.desks()) }
    var activeDesk by remember { mutableStateOf<SavedDesk?>(null) }
    var target by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    var saveDialog by remember { mutableStateOf(false) }
    var captureInfoOpen by remember { mutableStateOf(false) }
    val online = remember { mutableStateMapOf<String, Boolean>() }
    val autoConnected = remember { mutableSetOf<String>() }
    val notificationLauncher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) {}

    LaunchedEffect(showCaptureOnStart) {
        if (showCaptureOnStart) onCapturePermission()
    }
    LaunchedEffect(Unit) {
        if (!store.hasSeenCaptureLimit) captureInfoOpen = true
        if (Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(context, android.Manifest.permission.POST_NOTIFICATIONS) !=
            android.content.pm.PackageManager.PERMISSION_GRANTED) {
            notificationLauncher.launch(android.Manifest.permission.POST_NOTIFICATIONS)
        }
    }
    LaunchedEffect(serverUrl, desks) {
        while (true) {
            val states = withContext(Dispatchers.IO) { fetchOnline(serverUrl, desks) }
            online.clear()
            online.putAll(states)
            desks.filter { it.autoConnect && it.password.isNotEmpty() }.forEach { desk ->
                if (states[desk.target] == true && autoConnected.add(desk.target)) {
                    activeDesk = desk
                } else if (states[desk.target] != true) autoConnected.remove(desk.target)
            }
            delay(8000)
        }
    }

    BackHandler(activeDesk != null) { activeDesk = null }
    if (activeDesk != null) {
        ViewerScreen(
            serverUrl = serverUrl,
            desk = activeDesk!!,
            onBack = { activeDesk = null }
        )
        return
    }

    Scaffold(
        containerColor = Background,
        topBar = {
            Row(
                Modifier.fillMaxWidth().background(Background).padding(horizontal = 20.dp, vertical = 16.dp),
                verticalAlignment = Alignment.CenterVertically
            ) {
                Column(Modifier.weight(1f)) {
                    Text("Bainsla Remote", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
                    Text("Secure remote access", color = Muted, style = MaterialTheme.typography.bodySmall)
                }
                IconButton(onClick = { settingsOpen = true }) {
                    Icon(Icons.Default.Settings, contentDescription = "Settings", tint = Color.White)
                }
            }
        },
        bottomBar = {
            NavigationBar(containerColor = Surface) {
                listOf("Connect", "This phone").forEachIndexed { index, title ->
                    NavigationBarItem(
                        selected = tab == index,
                        onClick = { tab = index },
                        icon = { Text(if (index == 0) "↗" else "●", color = if (tab == index) Accent else Muted) },
                        label = { Text(title) }
                    )
                }
            }
        }
    ) { insets ->
        if (tab == 0) {
            ConnectScreen(
                Modifier.padding(insets),
                serverUrl, target, password, desks, online,
                onTarget = { target = it },
                onPassword = { password = it },
                onConnect = {
                    val value = target.trim().replace(Regex("\\s"), "")
                    if (value.isNotEmpty()) activeDesk = SavedDesk(value, value, password, false)
                },
                onSave = { saveDialog = true },
                onDeskConnect = { activeDesk = it },
                onToggleAuto = { desk, enabled ->
                    desks = desks.map { if (it.target == desk.target) it.copy(autoConnect = enabled) else it }
                    store.saveDesks(desks)
                },
                onRemove = { desk ->
                    desks = desks.filterNot { it.target == desk.target }
                    store.saveDesks(desks)
                }
            )
        } else {
            ThisPhoneScreen(
                modifier = Modifier.padding(insets),
                store = store,
                host = host,
                onStart = { onStartService(true) },
                onCapture = {
                    if (host.status == "Offline") {
                        onStartService(false)
                        Handler(Looper.getMainLooper()).postDelayed(onCapturePermission, 450)
                    } else onCapturePermission()
                },
                onStop = onStopService,
                onPermission = {
                    context.startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))
                },
                onBattery = {
                    if (Build.VERSION.SDK_INT >= 23) {
                        val intent = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS)
                            .setData(Uri.parse("package:${context.packageName}"))
                        runCatching { context.startActivity(intent) }
                    }
                },
                onCopyId = {
                    val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                    clipboard.setPrimaryClip(ClipData.newPlainText("Bainsla Remote ID", host.id.orEmpty()))
                },
                onSavePassword = { value ->
                    scope.launch(Dispatchers.Default) {
                        if (value.isBlank()) store.clearUnattendedPassword()
                        else {
                            val salt = PasswordHasher.newSalt()
                            store.saveUnattendedPassword(salt, PasswordHasher.hash(value, salt))
                        }
                    }
                }
            )
        }
    }

    if (settingsOpen) {
        ModalBottomSheet(onDismissRequest = { settingsOpen = false }, containerColor = Surface) {
            Column(Modifier.fillMaxWidth().padding(24.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Text("Settings", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold)
                OutlinedTextField(serverUrl, { serverUrl = it }, label = { Text("Server URL") }, singleLine = true, modifier = Modifier.fillMaxWidth())
                OutlinedTextField(deviceName, { deviceName = it }, label = { Text("Device name") }, singleLine = true, modifier = Modifier.fillMaxWidth())
                Button(onClick = {
                    runCatching { require(Uri.parse(serverUrl).scheme in listOf("https", "http")) }
                        .onSuccess {
                            store.serverUrl = serverUrl
                            store.deviceName = deviceName
                            if (host.status != "Offline") {
                                context.stopService(Intent(context, DeskService::class.java))
                                Handler(Looper.getMainLooper()).postDelayed({ DeskService.start(context) }, 500)
                            }
                            settingsOpen = false
                        }
                }, modifier = Modifier.fillMaxWidth()) { Text("Save settings") }
                Spacer(Modifier.height(12.dp))
            }
        }
    }

    if (saveDialog) {
        var label by remember { mutableStateOf("") }
        AlertDialog(
            onDismissRequest = { saveDialog = false },
            title = { Text("Save desk") },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(target.trim().ifEmpty { "Enter a desk first" }, color = Muted)
                    OutlinedTextField(label, { label = it }, label = { Text("Name") }, singleLine = true)
                    Text("Password is encrypted on this phone.", color = Muted, style = MaterialTheme.typography.bodySmall)
                }
            },
            confirmButton = {
                TextButton(onClick = {
                    val value = target.trim().replace(" ", "")
                    if (value.isNotEmpty()) {
                        desks = (desks.filterNot { it.target.equals(value, true) } +
                            SavedDesk(value, label.ifBlank { value }, password, false))
                        store.saveDesks(desks)
                    }
                    saveDialog = false
                }) { Text("Save") }
            },
            dismissButton = { TextButton(onClick = { saveDialog = false }) { Text("Cancel") } },
            containerColor = Surface
        )
    }

    if (captureInfoOpen) {
        AlertDialog(
            onDismissRequest = {
                store.hasSeenCaptureLimit = true
                captureInfoOpen = false
            },
            title = { Text("Screen sharing needs approval") },
            text = { Text("Android asks you to tap Start now after each reboot and, on Android 14+, for every new capture session. Bainsla Remote keeps an approved capture alive while its service runs.") },
            confirmButton = {
                TextButton(onClick = {
                    store.hasSeenCaptureLimit = true
                    captureInfoOpen = false
                }) { Text("Got it") }
            },
            containerColor = Surface
        )
    }
}

@Composable
private fun ConnectScreen(
    modifier: Modifier,
    serverUrl: String,
    target: String,
    password: String,
    desks: List<SavedDesk>,
    online: Map<String, Boolean>,
    onTarget: (String) -> Unit,
    onPassword: (String) -> Unit,
    onConnect: () -> Unit,
    onSave: () -> Unit,
    onDeskConnect: (SavedDesk) -> Unit,
    onToggleAuto: (SavedDesk, Boolean) -> Unit,
    onRemove: (SavedDesk) -> Unit
) {
    Column(modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 18.dp)) {
        Card(
            colors = CardDefaults.cardColors(containerColor = Surface),
            shape = RoundedCornerShape(22.dp),
            modifier = Modifier.fillMaxWidth().padding(top = 4.dp)
        ) {
            Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Text("Connect to a Desk", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold)
                OutlinedTextField(target, onTarget, label = { Text("Desk ID or alias") }, singleLine = true,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Ascii), modifier = Modifier.fillMaxWidth())
                OutlinedTextField(password, onPassword, label = { Text("Password (if required)") }, singleLine = true,
                    visualTransformation = PasswordVisualTransformation(), modifier = Modifier.fillMaxWidth())
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Button(onClick = onConnect, modifier = Modifier.weight(1f)) { Text("Connect") }
                    OutlinedButton(onClick = onSave, modifier = Modifier.weight(1f)) { Text("Save desk") }
                }
            }
        }
        Row(Modifier.fillMaxWidth().padding(top = 22.dp, bottom = 8.dp), verticalAlignment = Alignment.CenterVertically) {
            Text("Saved desks", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
            Text("${desks.size}", color = Muted)
        }
        if (desks.isEmpty()) {
            Text("Your saved desks will appear here.", color = Muted, modifier = Modifier.padding(vertical = 8.dp))
        }
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            desks.forEach { desk ->
                Card(colors = CardDefaults.cardColors(containerColor = Surface), modifier = Modifier.fillMaxWidth()) {
                    Row(Modifier.padding(12.dp), verticalAlignment = Alignment.CenterVertically) {
                        Box(Modifier.size(10.dp).background(if (online[desk.target] == true) Color(0xFF22C55E) else Muted, CircleShape))
                        Spacer(Modifier.width(10.dp))
                        Column(Modifier.weight(1f).clickable { onDeskConnect(desk) }) {
                            Text(desk.label, fontWeight = FontWeight.SemiBold)
                            Text(desk.target, color = Muted, style = MaterialTheme.typography.bodySmall)
                        }
                        Column(horizontalAlignment = Alignment.CenterHorizontally) {
                            Switch(desk.autoConnect, { onToggleAuto(desk, it) })
                            Text("Auto", color = Muted, style = MaterialTheme.typography.labelSmall)
                        }
                        TextButton(onClick = { onRemove(desk) }) { Text("×", color = Muted) }
                    }
                }
            }
        }
        Text(serverUrl, color = Muted, style = MaterialTheme.typography.labelSmall, modifier = Modifier.padding(top = 10.dp))
    }
}

@Composable
private fun ThisPhoneScreen(
    modifier: Modifier,
    store: DeskStore,
    host: HostUiState,
    onStart: () -> Unit,
    onCapture: () -> Unit,
    onStop: () -> Unit,
    onPermission: () -> Unit,
    onBattery: () -> Unit,
    onCopyId: () -> Unit,
    onSavePassword: (String) -> Unit
) {
    var password by remember { mutableStateOf("") }
    var hasUnattendedPassword by remember { mutableStateOf(store.unattendedHash != null) }
    val accessibilityEnabled = DeskAccessibilityService.isEnabled(LocalContext.current)
    Column(modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 18.dp)) {
        Card(colors = CardDefaults.cardColors(containerColor = Surface), modifier = Modifier.fillMaxWidth()) {
            Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Text("This phone", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold)
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Box(Modifier.size(11.dp).background(if (host.status == "Online") Color(0xFF22C55E) else Accent, CircleShape))
                    Spacer(Modifier.width(8.dp))
                    Text(host.status, color = Muted)
                }
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(host.id?.chunked(3)?.joinToString(" ") ?: "—", style = MaterialTheme.typography.headlineMedium,
                        fontWeight = FontWeight.Bold, modifier = Modifier.weight(1f))
                    IconButton(onClick = onCopyId, enabled = host.id != null) {
                        Icon(Icons.Default.ContentCopy, contentDescription = "Copy ID", tint = Color.White)
                    }
                }
                Text("Fixed device ID · Android host", color = Muted, style = MaterialTheme.typography.bodySmall)
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Button(
                    onClick = {
                        if (host.status == "Offline") onStart() else if (!host.capturing) onCapture()
                    },
                    enabled = !host.capturing,
                    modifier = Modifier.weight(1f)
                ) {
                    Text(if (host.status == "Offline") "Start sharing service" else "Allow screen sharing")
                }
                OutlinedButton(onClick = onStop) { Text("Stop") }
            }
            }
        }
        Card(colors = CardDefaults.cardColors(containerColor = Surface), modifier = Modifier.fillMaxWidth().padding(top = 12.dp)) {
            Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Text("Permissions", fontWeight = FontWeight.SemiBold)
                PermissionRow("Screen capture", if (host.capturing) "Ready" else "Tap Start now", host.capturing)
                Row(Modifier.fillMaxWidth().clickable(onClick = onPermission).padding(vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text(if (accessibilityEnabled) "✓" else "○", color = if (accessibilityEnabled) Color(0xFF22C55E) else Accent)
                    Text("  Accessibility control", modifier = Modifier.weight(1f))
                    Text("Open", color = Accent)
                }
                Row(Modifier.fillMaxWidth().clickable(onClick = onBattery).padding(vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text("○", color = Accent)
                    Text("  Battery optimisation", modifier = Modifier.weight(1f))
                    Text("Allow", color = Accent)
                }
                Text("Android asks you to approve screen sharing after reboot and for each new Android 14 capture session.", color = Muted,
                    style = MaterialTheme.typography.bodySmall)
            }
        }
        Card(colors = CardDefaults.cardColors(containerColor = Surface), modifier = Modifier.fillMaxWidth().padding(top = 12.dp)) {
            Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("Unattended password", fontWeight = FontWeight.SemiBold)
                OutlinedTextField(password, { password = it }, singleLine = true, label = { Text("Fixed password") },
                    visualTransformation = PasswordVisualTransformation(), modifier = Modifier.fillMaxWidth())
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Button(onClick = {
                        if (password.length >= 8) {
                            onSavePassword(password)
                            hasUnattendedPassword = true
                            password = ""
                        }
                    }, modifier = Modifier.weight(1f)) { Text("Save password") }
                    TextButton(onClick = {
                        onSavePassword("")
                        hasUnattendedPassword = false
                        password = ""
                    }) { Text("Remove") }
                }
                Text(if (!hasUnattendedPassword) "Unattended access is off." else "Password is fixed and stored encrypted on this phone.",
                    color = Muted, style = MaterialTheme.typography.bodySmall)
            }
        }
    }
}

@Composable
private fun PermissionRow(label: String, value: String, ready: Boolean) {
    Row(Modifier.fillMaxWidth().padding(vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(if (ready) "✓" else "○", color = if (ready) Color(0xFF22C55E) else Accent)
        Text("  $label", modifier = Modifier.weight(1f))
        Text(value, color = Muted, style = MaterialTheme.typography.bodySmall)
    }
}

@Composable
private fun ViewerScreen(serverUrl: String, desk: SavedDesk, onBack: () -> Unit) {
    val context = LocalContext.current
    var webView by remember { mutableStateOf<WebView?>(null) }
    BackHandler(onBack = onBack)
    Box(Modifier.fillMaxSize().background(Color.Black)) {
        AndroidView(
            modifier = Modifier.fillMaxSize(),
            factory = {
                WebView(it).apply {
                    webView = this
                    settings.javaScriptEnabled = true
                    settings.domStorageEnabled = true
                    settings.mediaPlaybackRequiresUserGesture = false
                    settings.setSupportZoom(false)
                    webViewClient = object : WebViewClient() {
                        override fun onPageFinished(view: WebView, url: String) {
                            view.evaluateJavascript(
                                """
                                    (() => {
                                      const fit = () => {
                                        const header = document.querySelector('.viewer-bar');
                                        const layout = document.querySelector('.viewer-layout');
                                        if (!header || !layout) return;
                                        header.style.display = 'none';
                                        document.querySelector('.viewer-help')?.style.setProperty('display', 'none');
                                        const connectCard = document.querySelector('.connect-card');
                                        if (connectCard) connectCard.hidden = true;
                                        const height = window.visualViewport?.height || window.innerHeight;
                                        document.documentElement.style.height = height + 'px';
                                        document.body.style.height = height + 'px';
                                        layout.style.height = height + 'px';
                                      };
                                      if (!window.__kvDeskViewportFit) {
                                        window.__kvDeskViewportFit = fit;
                                        window.addEventListener('resize', fit);
                                        window.visualViewport?.addEventListener('resize', fit);
                                      }
                                      window.__kvDeskViewportFit();
                                    })();
                                """.trimIndent(),
                                null
                            )
                            val target = JSONObject.quote(desk.target)
                            val password = JSONObject.quote(desk.password)
                            val script = """
                                (function connectKvDesk() {
                                  const id = document.getElementById('target-id');
                                  const pass = document.getElementById('viewer-password');
                                  const button = document.getElementById('connect-button');
                                  if (!id || !pass || !button) { setTimeout(connectKvDesk, 250); return; }
                                  id.value = $target;
                                  pass.value = $password;
                                  button.click();
                                  setTimeout(() => { pass.value = ''; }, 1000);
                                  window.__kvDeskSendCtl = window.__kvDeskSendCtl || null;
                                })();
                            """.trimIndent()
                            view.evaluateJavascript(script, null)
                        }
                    }
                    val url = "${serverUrl.trimEnd('/')}/v/?app=1"
                    loadUrl(url)
                }
            }
        )
        Row(
            Modifier.align(Alignment.TopCenter).fillMaxWidth().background(Color(0xDD111827))
                .horizontalScroll(rememberScrollState()).padding(horizontal = 6.dp, vertical = 4.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            ShortcutButton("⌨") {
                webView?.let { activeWebView ->
                    activeWebView.requestFocus()
                    activeWebView.evaluateJavascript("document.getElementById('mobile-keyboard')?.focus()") {
                        activeWebView.requestFocus()
                        (context.getSystemService(Context.INPUT_METHOD_SERVICE) as? InputMethodManager)
                            ?.showSoftInput(activeWebView, InputMethodManager.SHOW_IMPLICIT)
                    }
                }
            }
            ShortcutButton("Esc") { sendKey(webView, "Escape", "Escape") }
            ShortcutButton("Tab") { sendKey(webView, "Tab", "Tab") }
            ShortcutButton("Win") { sendControl(webView, JSONObject().put("t", "combo").put("k", "win")) }
            ShortcutButton("Ctrl+C") { sendControlChord(webView, "KeyC", "c") }
            ShortcutButton("Ctrl+V") { sendControlChord(webView, "KeyV", "v") }
            ShortcutButton("Chat") { webView?.evaluateJavascript("document.getElementById('chat-toggle')?.click()", null) }
            ShortcutButton("Disconnect") {
                webView?.evaluateJavascript("document.getElementById('disconnect-button')?.click()", null)
                onBack()
            }
        }
    }
    val activeWebView = webView
    DisposableEffect(activeWebView) {
        onDispose {
            activeWebView?.evaluateJavascript("document.getElementById('disconnect-button')?.click()", null)
            activeWebView?.stopLoading()
            activeWebView?.destroy()
        }
    }
}

@Composable
private fun ShortcutButton(label: String, action: () -> Unit) {
    TextButton(
        onClick = action,
        colors = ButtonDefaults.textButtonColors(contentColor = Color.White),
        modifier = Modifier.padding(horizontal = 2.dp)
    ) { Text(label, style = MaterialTheme.typography.labelSmall) }
}

private fun sendControl(webView: WebView?, message: JSONObject) {
    val literal = message.toString()
    webView?.evaluateJavascript("window.__kvDeskSendCtl?.($literal)", null)
}

private fun sendKey(webView: WebView?, code: String, key: String) {
    val codeJson = JSONObject.quote(code)
    val keyJson = JSONObject.quote(key)
    webView?.evaluateJavascript(
        "window.__kvDeskSendCtl?.({t:'kd',code:$codeJson,key:$keyJson});window.__kvDeskSendCtl?.({t:'ku',code:$codeJson,key:$keyJson})",
        null
    )
}

private fun sendControlChord(webView: WebView?, code: String, key: String) {
    val codeJson = JSONObject.quote(code)
    val keyJson = JSONObject.quote(key)
    webView?.evaluateJavascript(
        "window.__kvDeskSendCtl?.({t:'kd',code:'ControlLeft',key:'Control'});" +
            "window.__kvDeskSendCtl?.({t:'kd',code:$codeJson,key:$keyJson});" +
            "window.__kvDeskSendCtl?.({t:'ku',code:$codeJson,key:$keyJson});" +
            "window.__kvDeskSendCtl?.({t:'ku',code:'ControlLeft',key:'Control'})",
        null
    )
}

private suspend fun fetchOnline(server: String, desks: List<SavedDesk>): Map<String, Boolean> {
    if (desks.isEmpty()) return emptyMap()
    return runCatching {
        val ids = desks.joinToString(",") { it.target }
        val url = URL("${server.trimEnd('/')}/api/status?ids=${Uri.encode(ids)}")
        val connection = (url.openConnection() as HttpURLConnection).apply {
            connectTimeout = 4000
            readTimeout = 4000
        }
        val response = connection.inputStream.bufferedReader().use { it.readText() }
        connection.disconnect()
        val json = JSONObject(response)
        desks.associate { it.target to json.optBoolean(it.target, false) }
    }.getOrDefault(desks.associate { it.target to false })
}
