/**
 * This file handles user input validation
 */
import { z } from 'zod/v4'
import { isAddress } from 'ethers'

const EthereumAddressSchema = z.string().refine((val) => isAddress(val), {
  message: 'Invalid Ethereum address. Check format and checksum.'
})

const NonEmptyStringSchema = z.string().min(1, { message: 'Name cannot be empty.' })

export const PublicKeySchema = z.string().regex(/^[a-zA-Z0-9+/=]+$/)
const FolderIdSchema = z.uuidv4().nullable()
export const FileIdSchema = z.uuidv4()
const HexStringSchema = z.string().regex(/^[0-9a-fA-F]+$/)

// CryptoHandler.js
export const Base64Schema = z.base64()

// Authentication.js
export const RegisterRequestSchema = z.object({
  publicKey: PublicKeySchema,
  blockchainAddress: EthereumAddressSchema,
  name: NonEmptyStringSchema,
  email: z.email()
})

export const LoginRequestSchema = z.object({
  publicKey: PublicKeySchema
})

export const AuthResRequestSchema = z.object({
  decryptedValue: z.string()
})

export const SecretShareRequestSchema = z.object({
  shares: z.string().array()
})

export const SecretRecoverRequestSchema = z.object({
  email: z.email()
})

export const EmailAuthResRequestSchema = z.object({
  emailAuth: z.string()
})

// RecoveryService.js (fingerprint / security-key recovery)
const Base64UrlSchema = z.string().regex(/^[A-Za-z0-9_-]+$/)
const RecoveryMethodIdSchema = z.uuidv4()
const RecoveryLabelSchema = z.string().trim().max(64)

export const FidoBindBeginRequestSchema = z.object({
  label: RecoveryLabelSchema.optional()
})

export const FidoBindFinishRequestSchema = z.object({
  credential: z.object({
    id: Base64UrlSchema.max(1024),
    clientDataJSON: Base64UrlSchema.max(4096),
    attestationObject: Base64UrlSchema.max(16384)
  }),
  // Same encoding as secret-share: the client's Shamir shares in standard base64.
  shares: z.base64().max(200000).array().min(2).max(10),
  label: RecoveryLabelSchema.optional()
})

export const FidoRecoverBeginRequestSchema = z.object({
  methodId: RecoveryMethodIdSchema
})

export const FidoRecoverFinishRequestSchema = z.object({
  assertion: z.object({
    id: Base64UrlSchema.max(1024),
    clientDataJSON: Base64UrlSchema.max(4096),
    authenticatorData: Base64UrlSchema.max(4096),
    signature: Base64UrlSchema.max(1024),
    userHandle: Base64UrlSchema.max(512).nullable().optional()
  })
})

export const RecoveryMethodDeleteRequestSchema = z.object({
  methodId: RecoveryMethodIdSchema
})

// FileManager.js
export const DownloadFileRequestSchema = z.object({
  fileId: FileIdSchema
})

// TODO: maybe transform bigint to hex
export const DownloadFileHashErrorRequestSchema = z.object({
  fileId: FileIdSchema,
  blockchainHash: z.bigint(),
  fileHash: z.bigint()
})

export const UploadFileRequestSchema = z.object({
  cipher: z.string(),
  spk: z.string(),
  parentFolderId: FolderIdSchema
})

export const DeleteFileRequestSchema = z.object({
  fileId: FileIdSchema
})

export const GetFileListRequestSchema = z.object({
  parentFolderId: FolderIdSchema
})

export const AddFolderRequestSchema = z.object({
  parentFolderId: FolderIdSchema,
  folderName: NonEmptyStringSchema
})

export const DeleteFolderRequestSchema = z.object({
  folderId: FolderIdSchema
})

export const MoveFileRequestSchema = z.object({
  fileId: FileIdSchema,
  targetFolderId: FolderIdSchema
})

const CTwSchema = z.object({
  ctStar: HexStringSchema,
  ctw: HexStringSchema.array(),
  ct: HexStringSchema.array()
})

export const UpdateFileRequestSchema = z.object({
  fileId: FileIdSchema,
  description: z.string(),
  permission: z.union([z.literal(0), z.literal(1), z.literal(2)]),
  CTw: CTwSchema.nullable(),
  // Tags and attrIds are now stored server-side (migrated from client SQLite)
  tags: z.array(z.string().max(50)).max(5).optional().default([]),
  attrIds: z.array(z.number().int().min(0)).optional().default([])
})

const TKSchema = z.object({
  TStar: HexStringSchema,
  T: HexStringSchema.array(),
  sky: HexStringSchema,
  dPrime: z.number()
})

// export const SearchFileRequestSchema = z.object({
//   TK: TKSchema,
//   tags: z.string().array()
// })
// const TKSchema = z.any()

export const SearchFileRequestSchema = z.object({
  tags: z.array(z.string()).min(1).max(5),
  // ✅ 新版本：多個 trapdoor
  TKs: z.array(TKSchema).min(1).max(5).optional(),
  // ✅ 舊版本：單個 trapdoor（相容）
  TK: TKSchema.optional()
}).refine((v) => v.TKs?.length || v.TK, {
  message: 'Either TKs or TK must be provided.'
})

export const DownloadWithWatermarkRequestSchema = z.object({
  fileId: FileIdSchema,
  mode: z.enum(['original', 'watermark']),
  watermark: z
    .object({
      visible: z.boolean(),
      invisible: z.boolean(),
      customNote: z.string().optional().default(''),
      position: z.enum(['bottomRight', 'bottomLeft', 'diagonal']).optional().default('bottomRight'),
      opacity: z.number().min(0).max(1).optional().default(0.3),
      fontSize: z.number().min(8).max(48).optional().default(14)
    })
    .nullable()
})

/**
 * Second phase of the watermark-download flow: the client tells us whether
 * the file actually landed on disk after applying the watermark, so we know
 * whether the matching download_log entry should be committed or rolled back.
 *
 * `success === false` is an explicit failure signal (encryption/write/etc).
 * If neither commit nor cancel arrives, the server-side TTL sweep will drop
 * the pending request and the log entry simply never materializes — which is
 * the right answer when we have no evidence the download succeeded.
 */
export const ConfirmWatermarkDownloadRequestSchema = z.object({
  requestId: z.uuidv4(),
  success: z.boolean(),
  errorMsg: z.string().max(500).optional()
})

// RequestManager.js
export const ReqeustFileRequestSchema = z.object({
  fileId: FileIdSchema,
  description: z.string()
})

export const DeleteRequestRequestSchema = z.object({
  requestId: z.uuidv4()
})

export const RespondRequestRequestSchema = z.object({
  requestId: z.uuidv4(),
  agreed: z.boolean(),
  description: z.string(),
  rekey: z.string().nullable()
})

// HttpsServer.js
export const SocketIDSchema = z.string()

// AgentLogManager.js
export const AgentLogRequestSchema = z.object({
  conversationId: z.uuidv4(),
  provider: z.string().max(32).optional(),
  userMessage: z.string().min(1).max(20000),
  assistantMessage: z.string().max(20000),
  matchedFileIds: z.array(FileIdSchema).max(100).optional()
})

export const AgentHistoryRequestSchema = z.object({
  limit: z.number().int().min(1).max(50).optional()
})

// AdminManager.js
export const AdminUserIdRequestSchema = z.object({
  userId: z.uuidv4()
})
