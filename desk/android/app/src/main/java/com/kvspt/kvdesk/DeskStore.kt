package com.kvspt.kvdesk

import android.content.Context
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import org.json.JSONArray
import org.json.JSONObject

data class SavedDesk(
    val target: String,
    val label: String,
    val password: String,
    val autoConnect: Boolean
)

class DeskStore(context: Context) {
    private val prefs = EncryptedSharedPreferences.create(
        context,
        "kvdesk-secure",
        MasterKey.Builder(context).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build(),
        EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
        EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
    )

    var serverUrl: String
        get() = prefs.getString("serverUrl", "https://remote.bainslamusic.com") ?: "https://remote.bainslamusic.com"
        set(value) { prefs.edit().putString("serverUrl", value.trimEnd('/')).apply() }

    var deviceName: String
        get() = prefs.getString("deviceName", "Bainsla Remote Android") ?: "Bainsla Remote Android"
        set(value) { prefs.edit().putString("deviceName", value.trim()).apply() }

    val deviceId: String?
        get() = prefs.getString("deviceId", null)

    val deviceSecret: String?
        get() = prefs.getString("deviceSecret", null)

    val unattendedSalt: String?
        get() = prefs.getString("unattendedSalt", null)

    val unattendedHash: String?
        get() = prefs.getString("unattendedHash", null)

    var hasSeenCaptureLimit: Boolean
        get() = prefs.getBoolean("hasSeenCaptureLimit", false)
        set(value) { prefs.edit().putBoolean("hasSeenCaptureLimit", value).apply() }

    fun saveDevice(id: String, secret: String) {
        prefs.edit().putString("deviceId", id).putString("deviceSecret", secret).apply()
    }

    fun saveUnattendedPassword(salt: String, hash: String) {
        prefs.edit().putString("unattendedSalt", salt).putString("unattendedHash", hash).apply()
    }

    fun clearUnattendedPassword() {
        prefs.edit().remove("unattendedSalt").remove("unattendedHash").apply()
    }

    fun desks(): List<SavedDesk> {
        val json = prefs.getString("savedDesks", "[]") ?: "[]"
        return runCatching {
            val items = JSONArray(json)
            (0 until items.length()).map { index ->
                val item = items.getJSONObject(index)
                SavedDesk(
                    target = item.optString("target"),
                    label = item.optString("label"),
                    password = item.optString("password"),
                    autoConnect = item.optBoolean("autoConnect")
                )
            }
        }.getOrDefault(emptyList())
    }

    fun saveDesks(desks: List<SavedDesk>) {
        val items = JSONArray()
        desks.forEach { desk ->
            items.put(JSONObject()
                .put("target", desk.target)
                .put("label", desk.label)
                .put("password", desk.password)
                .put("autoConnect", desk.autoConnect))
        }
        prefs.edit().putString("savedDesks", items.toString()).apply()
    }
}
