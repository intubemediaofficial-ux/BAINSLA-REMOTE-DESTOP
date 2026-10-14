package com.kvspt.kvdesk

import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class PasswordHasherTest {
    @Test
    fun saltedHashesVerifyOnlyTheMatchingPassword() {
        val salt = PasswordHasher.newSalt()
        val hash = PasswordHasher.hash("fixed-password", salt)

        assertTrue(PasswordHasher.verify("fixed-password", salt, hash))
        assertFalse(PasswordHasher.verify("wrong-password", salt, hash))
        assertNotEquals(hash, PasswordHasher.hash("fixed-password", PasswordHasher.newSalt()))
    }
}
