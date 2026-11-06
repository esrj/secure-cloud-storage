/**
 * Metadata-only smart search agent chat page.
 *
 * The agent can only see non-sensitive metadata:
 * name, extension, size, date, permission, description, tags.
 * It never receives file content or cryptographic material.
 */
import { useState, useEffect, useRef, useCallback, useContext } from 'react'
import { Input, Button, Typography } from '@material-tailwind/react'
import { PaperAirplaneIcon, TrashIcon } from '@heroicons/react/24/outline'
import AgentMessageBubble from './AgentMessageBubble'
import toast from 'react-hot-toast'
import { parseFileList } from './Types'
import { ProfileContext, AgentChatContext } from './Contexts'

export const WELCOME = {
  id: 'welcome',
  role: 'assistant',
  content:
    '你好！我是智慧搜尋助手。\n\n我可以依據檔名、標籤、分類、日期、大小等 metadata 幫你找到需要的文件。\n\n注意：使用雲端 Gemini 模式時，僅權限設為「公開」的檔案可被搜尋；本機模型模式可搜尋目前清單內全部檔案。\n\n請問有什麼需要搜尋的嗎？',
  files: [],
  matchCount: 0,
  totalCount: 0
}

export default function AgentPage() {
  const {
    storedNameC: [uploaderName],
    userIdC: [userId]
  } = useContext(ProfileContext)

  // Conversation state is lifted to App via AgentChatContext so it
  // survives switching to other pages (AgentPage unmounts on switch).
  const {
    messagesC: [messages, setMessages],
    historyC: historyRef,
    conversationIdC: conversationIdRef
  } = useContext(AgentChatContext)

  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [fileList, setFileList] = useState([])
  const scrollRef = useRef(null)
  const isComposingRef = useRef(false)

  const [folders, setFolders] = useState([])
  const [scopeError, setScopeError] = useState('')

  // Search scope = all of my files (every folder) + every public file of other
  // users, metadata only. It has its own IPC so the file list page is never
  // affected by what the agent loads.
  const loadScope = useCallback(async () => {
    try {
      const res = await window.electronAPI.agentFileScope()
      if (!res?.ok) throw new Error(res?.error || '未知錯誤')
      const parsed = parseFileList(res.files, false)
      setFileList(parsed)
      setFolders(res.folders ?? [])
      setScopeError('')
      return parsed
    } catch (e) {
      console.error('[AgentPage] load scope error:', e)
      setScopeError(e.message)
      return null
    }
  }, [])

  useEffect(() => {
    void loadScope()
  }, [loadScope])

  // Auto-scroll to bottom whenever messages change
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
  }, [messages])

  const sendMessage = useCallback(async () => {
    const text = input.trim()
    if (!text || loading) return

    setInput('')
    setLoading(true)

    const userMsg = { id: crypto.randomUUID(), role: 'user', content: text }
    const thinkingMsg = { id: 'thinking', role: 'assistant', content: '', isLoading: true }

    setMessages((prev) => [...prev, userMsg, thinkingMsg])

    try {
      // Refresh the scope right before searching; fall back to the last list.
      const scope = (await loadScope()) ?? fileList
      const result = await window.electronAPI.agentQuery({
        userMessage: text,
        history: historyRef.current,
        rawFiles: scope,
        folders,
        uploaderName: uploaderName ?? '',
        currentUserId: userId ?? ''
      })

      const assistantContent = result.ok
        ? result.summary
        : `搜尋發生錯誤：${result.error ?? '未知錯誤'}。請稍後再試。`

      const assistantMsg = {
        id: crypto.randomUUID(),
        role: 'assistant',
        content: assistantContent,
        files: result.ok ? (result.files ?? []) : [],
        matchCount: result.ok ? (result.matchCount ?? 0) : 0,
        totalCount: result.ok ? (result.totalCount ?? 0) : 0
      }

      // Update history (exclude loading placeholder and welcome message)
      historyRef.current = [
        ...historyRef.current,
        { role: 'user', content: text },
        { role: 'assistant', content: assistantContent }
      ].slice(-12) // keep last 6 exchanges

      setMessages((prev) => [...prev.filter((m) => m.id !== 'thinking'), assistantMsg])

      // Persist the turn on the server (admin audit + cross-restart history).
      // Fire-and-forget: a logging failure must never block the chat.
      void window.electronAPI.agentLog?.({
        conversationId: conversationIdRef.current,
        provider: result.provider,
        userMessage: text,
        assistantMessage: assistantContent,
        matchedFileIds: (result.ok ? (result.files ?? []) : [])
          .map((f) => f.fileId ?? f.id ?? f.uuid)
          .filter((id) => typeof id === 'string')
          .slice(0, 100)
      })
    } catch (e) {
      toast.error(`智慧搜尋失敗：${e.message}`)
      setMessages((prev) => prev.filter((m) => m.id !== 'thinking'))
    } finally {
      setLoading(false)
    }
  }, [input, loading, fileList, folders, userId, uploaderName, loadScope])

  function handleKeyDown(e) {
    if (e.key === 'Enter' && !e.shiftKey && !isComposingRef.current) {
      e.preventDefault()
      void sendMessage()
    }
  }

  function clearChat() {
    setMessages([WELCOME])
    historyRef.current = []
    // A cleared chat starts a new server-side conversation.
    conversationIdRef.current = crypto.randomUUID()
    void loadScope()
  }

  return (
    <div className="flex h-full w-full flex-col overflow-hidden">
      {/* ── Header ── */}
      <div className="flex shrink-0 items-center justify-between border-b border-blue-gray-100 bg-white px-5 py-3">
        <div>
          <Typography variant="h6" className="text-blue-gray-900">
            智慧搜尋助手
          </Typography>
          {scopeError && (
            <Typography variant="small" className="text-xs text-red-500">
              清單載入失敗：{scopeError}
            </Typography>
          )}
        </div>
        <button
          onClick={clearChat}
          className="flex items-center gap-1.5 rounded-lg p-2 text-blue-gray-400 hover:bg-blue-gray-50 hover:text-blue-gray-700 transition-colors"
          title="清除對話"
        >
          <TrashIcon className="size-4" />
        </button>
      </div>

      {/* ── Message area ── */}
      <div
        ref={scrollRef}
        className="flex-1 space-y-4 overflow-y-auto px-5 py-4 bg-blue-gray-50/40"
      >
        {messages.map((msg) => (
          <AgentMessageBubble
            key={msg.id}
            role={msg.role}
            content={msg.content}
            files={msg.files}
            matchCount={msg.matchCount}
            totalCount={msg.totalCount}
            isLoading={msg.isLoading ?? false}
            currentUserId={userId ?? ''}
          />
        ))}
      </div>

      {/* ── Input area ── */}
      <div className="shrink-0 border-t border-blue-gray-100 bg-white px-5 py-4">
        <div className="flex h-11 items-stretch gap-2">
          <Input
            placeholder="輸入搜尋需求，例如：找 2024 年後的海軍相關 PDF…"
            labelProps={{ className: 'hidden' }}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onCompositionStart={() => { isComposingRef.current = true }}
            onCompositionEnd={() => { isComposingRef.current = false }}
            onKeyDown={handleKeyDown}
            disabled={loading}
            className="flex-1 rounded-xl focus:!border-blue-500"
            containerProps={{ className: '!min-w-0 flex-1 h-full' }}
          />
          <Button
            onClick={() => void sendMessage()}
            disabled={loading || !input.trim()}
            className="h-full w-12 shrink-0 flex items-center justify-center !p-0 rounded-xl bg-blue-600 hover:bg-blue-700 disabled:opacity-50"
          >
            <PaperAirplaneIcon className="size-5 text-white" />
          </Button>
        </div>
        <Typography variant="small" className="mt-1.5 text-center text-xs text-blue-gray-400">
          Enter 送出・Shift+Enter 換行・搜尋我的全部檔案與所有公開檔案的 metadata
        </Typography>
      </div>
    </div>
  )
}
