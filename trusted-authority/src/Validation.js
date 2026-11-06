/**
 * This file handles user input verification.
 */
import { z } from 'zod/v4'

// CryptoHandler.js
export const Base64Schema = z.base64()

const PublicKeySchema = z.string().regex(/^[a-zA-Z0-9+/=]+$/)


export const AuthRequestSchema = z.object({
  publicKey: PublicKeySchema
})

export const AuthResRequestSchema = z.object({
  decryptedValue: z.string(),
  y: z.array().nullable() // The attribute array
})