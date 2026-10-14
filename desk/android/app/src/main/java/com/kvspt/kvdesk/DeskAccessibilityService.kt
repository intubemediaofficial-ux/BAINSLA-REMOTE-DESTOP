package com.kvspt.kvdesk

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.content.ComponentName
import android.content.Context
import android.graphics.Path
import android.graphics.Point
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.view.Display
import android.view.View
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import android.view.WindowManager
import org.json.JSONObject
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min

class DeskAccessibilityService : AccessibilityService() {
    private var cursorX = 0.5f
    private var cursorY = 0.5f
    private var buttonDown: Int? = null
    private var gesturePath: Path? = null
    private var ctrlDown = false

    override fun onServiceConnected() {
        super.onServiceConnected()
        instance = this
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) = Unit
    override fun onInterrupt() = Unit

    override fun onDestroy() {
        if (instance === this) instance = null
        super.onDestroy()
    }

    private fun dispatch(message: JSONObject) {
        when (message.optString("t")) {
            "mm" -> {
                cursorX = message.optDouble("x", cursorX.toDouble()).toFloat().coerceIn(0f, 1f)
                cursorY = message.optDouble("y", cursorY.toDouble()).toFloat().coerceIn(0f, 1f)
                buttonDown?.let { gesturePath?.lineTo(pixelX(), pixelY()) }
            }
            "md" -> {
                buttonDown = message.optInt("b", 0)
                gesturePath = Path().apply { moveTo(pixelX(), pixelY()) }
            }
            "mu" -> {
                val button = buttonDown ?: return
                val path = gesturePath ?: Path().apply { moveTo(pixelX(), pixelY()) }
                path.lineTo(pixelX(), pixelY())
                val duration = if (button == 2) 650L else max(100L, min(1200L, path.lengthEstimate()))
                dispatchGesture(GestureDescription.Builder()
                    .addStroke(GestureDescription.StrokeDescription(path, 0, duration))
                    .build(), null, null)
                buttonDown = null
                gesturePath = null
            }
            "wh" -> scroll(message.optDouble("dx", 0.0).toFloat(), message.optDouble("dy", 0.0).toFloat())
            "nav" -> when (message.optString("k")) {
                "back" -> performGlobalAction(GLOBAL_ACTION_BACK)
                "home" -> performGlobalAction(GLOBAL_ACTION_HOME)
                "recents" -> performGlobalAction(GLOBAL_ACTION_RECENTS)
            }
            "combo" -> when (message.optString("k")) {
                "win" -> performGlobalAction(GLOBAL_ACTION_HOME)
                "alt-tab" -> performGlobalAction(GLOBAL_ACTION_RECENTS)
                "printscreen" -> if (Build.VERSION.SDK_INT >= 28) performGlobalAction(GLOBAL_ACTION_TAKE_SCREENSHOT)
            }
            "kd", "ku" -> key(message, message.optString("t") == "kd")
        }
    }

    private fun scroll(dx: Float, dy: Float) {
        val size = displaySize()
        val centerX = size.x / 2f
        val centerY = size.y / 2f
        val path = Path().apply {
            moveTo(centerX, centerY)
            lineTo(centerX - dx.coerceIn(-300f, 300f), centerY - dy.coerceIn(-500f, 500f))
        }
        dispatchGesture(GestureDescription.Builder()
            .addStroke(GestureDescription.StrokeDescription(path, 0, 350))
            .build(), null, null)
    }

    private fun key(message: JSONObject, down: Boolean) {
        val code = message.optString("code")
        val key = message.optString("key")
        if (code == "ControlLeft" || code == "ControlRight" || key == "Control") {
            ctrlDown = down
            return
        }
        if (!down) return
        if (key == "Escape" || code == "Escape") {
            performGlobalAction(GLOBAL_ACTION_BACK)
            return
        }
        val root = rootInActiveWindow ?: return
        val focused = root.findFocus(AccessibilityNodeInfo.FOCUS_INPUT)
        if (ctrlDown && (key.equals("c", true) || code == "KeyC")) {
            focused?.performAction(AccessibilityNodeInfo.ACTION_COPY)
            return
        }
        if (ctrlDown && (key.equals("v", true) || code == "KeyV")) {
            focused?.performAction(AccessibilityNodeInfo.ACTION_PASTE)
            return
        }
        if (key == "Tab" || code == "Tab") {
            focused?.focusSearch(View.FOCUS_FORWARD)?.performAction(AccessibilityNodeInfo.ACTION_FOCUS)
            return
        }
        val current = focused?.text?.toString().orEmpty()
        val updated = when (key) {
            "Backspace" -> if (current.isNotEmpty()) current.dropLast(1) else current
            "Enter" -> "$current\n"
            else -> if (key.length == 1) current + key else return
        }
        val args = Bundle().apply { putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, updated) }
        focused?.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args)
    }

    private fun pixelX(): Float = cursorX * displaySize().x
    private fun pixelY(): Float = cursorY * displaySize().y

    @Suppress("DEPRECATION")
    private fun displaySize(): Point {
        val point = Point()
        (getSystemService(WINDOW_SERVICE) as WindowManager).defaultDisplay.getRealSize(point)
        return point
    }

    private fun Path.lengthEstimate(): Long = max(100L, (abs(cursorX - 0.5f) + abs(cursorY - 0.5f) * 1000).toLong())

    companion object {
        @Volatile private var instance: DeskAccessibilityService? = null

        fun dispatch(message: JSONObject) {
            instance?.dispatch(message)
        }

        fun isEnabled(context: Context): Boolean {
            val enabled = Settings.Secure.getString(context.contentResolver, Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES).orEmpty()
            val expected = ComponentName(context, DeskAccessibilityService::class.java).flattenToString()
            return enabled.split(':').any { it.equals(expected, ignoreCase = true) }
        }
    }
}
