/**
 * A single chat message bubble (user or assistant).
 * Assistant messages include a collapsible file result list with
 * download (own files) or request (others' files) actions.
 */
import { useState } from 'react'
import { Typography, Chip } from '@material-tailwind/react'
import {
  ChevronDownIcon,
  ChevronUpIcon,
  DocumentTextIcon,
  ArrowDownTrayIcon,
  PaperAirplaneIcon
} from '@heroicons/react/24/outline'
import PropTypes from 'prop-types'
import toast from 'react-hot-toast'

// ─── File result card ─────────────────────────────────────────────────────────

function FileResultCard({ file, currentUserId }) {
  const isOwn =
    file.uploader_id && currentUserId ? file.uploader_id === currentUserId : false

  function handleDownload() {
    window.electronAPI?.askDownloadFile?.(file.fileId)
    toast('開始下載…', { id: `dl-${file.fileId}`, duration: 2000 })
  }

  function handleRequest() {
    window.electronAPI?.askRequestFile?.({ fileId: file.fileId, description: '' })
    toast.success('已送出文件請求')
  }

  return (
    <div className="flex items-start gap-3 rounded-lg border border-blue-gray-100 bg-white px-3 py-2.5 shadow-sm">
      <DocumentTextIcon className="mt-0.5 size-5 shrink-0 text-blue-gray-400" />
      <div className="min-w-0 flex-1">
        <Typography variant="small" className="truncate font-semibold text-blue-gray-900">
          {file.name}
        </Typography>

        {/* Metadata badges */}
        <div className="mt-1 flex flex-wrap gap-1.5">
          <span className="rounded-full bg-blue-gray-50 px-2 py-0.5 text-xs text-blue-gray-600">
            {file.sizeLabel}
          </span>
          <span className="rounded-full bg-blue-gray-50 px-2 py-0.5 text-xs text-blue-gray-600">
            {file.date}
          </span>
          <span className="rounded-full bg-blue-gray-50 px-2 py-0.5 text-xs text-blue-gray-600">
            {file.permLabel}
          </span>
          {file.location && (
            <span className="rounded-full bg-amber-50 px-2 py-0.5 text-xs text-amber-800">
              {file.location}
            </span>
          )}
          {file.ext && (
            <span className="rounded-full bg-indigo-50 px-2 py-0.5 text-xs font-medium text-indigo-700 uppercase">
              {file.ext}
            </span>
          )}
        </div>

        {/* Tags */}
        {file.tags?.length > 0 && (
          <div className="mt-1.5 flex flex-wrap gap-1">
            {file.tags.map((tag) => (
              <Chip
                key={tag}
                value={tag}
                size="sm"
                variant="ghost"
                color="blue"
                className="rounded-full py-0.5 text-xs"
              />
            ))}
          </div>
        )}

        {/* Description */}
        {file.desc && (
          <Typography variant="small" className="mt-1 truncate text-xs text-blue-gray-500">
            {file.desc}
          </Typography>
        )}

        {/* Action button */}
        <div className="mt-2 flex justify-end">
          {isOwn ? (
            <button
              onClick={handleDownload}
              className="flex items-center gap-1 rounded-full bg-blue-50 px-2.5 py-1 text-xs font-medium text-blue-700 hover:bg-blue-100 transition-colors"
            >
              <ArrowDownTrayIcon className="size-3.5" />
              下載
            </button>
          ) : (
            <button
              onClick={handleRequest}
              className="flex items-center gap-1 rounded-full bg-indigo-50 px-2.5 py-1 text-xs font-medium text-indigo-700 hover:bg-indigo-100 transition-colors"
            >
              <PaperAirplaneIcon className="size-3.5" />
              請求文件
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

FileResultCard.propTypes = {
  file: PropTypes.shape({
    fileId: PropTypes.string,
    name: PropTypes.string,
    ext: PropTypes.string,
    sizeLabel: PropTypes.string,
    date: PropTypes.string,
    permLabel: PropTypes.string,
    tags: PropTypes.arrayOf(PropTypes.string),
    desc: PropTypes.string,
    location: PropTypes.string,
    uploader_name: PropTypes.string,
    uploader_id: PropTypes.string
  }).isRequired,
  currentUserId: PropTypes.string
}

// ─── Main bubble ─────────────────────────────────────────────────────────────

function AgentMessageBubble({ role, content, files, matchCount, totalCount, isLoading, currentUserId }) {
  const [expanded, setExpanded] = useState(false)
  const isUser = role === 'user'

  if (isUser) {
    return (
      <div className="flex justify-end">
        <div className="max-w-[75%] rounded-2xl rounded-tr-sm bg-blue-600 px-4 py-2.5 shadow-sm">
          <Typography variant="small" className="whitespace-pre-wrap text-white">
            {content}
          </Typography>
        </div>
      </div>
    )
  }

  return (
    <div className="flex justify-start">
      <div className="max-w-[85%] space-y-2">
        {/* Avatar + summary */}
        <div className="flex items-start gap-2">
          <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-blue-500 to-indigo-600 text-xs font-bold text-white shadow">
            AI
          </div>
          <div className="rounded-2xl rounded-tl-sm bg-white px-4 py-2.5 shadow-sm border border-blue-gray-100">
            {isLoading ? (
              <div className="flex items-center gap-2">
                <span className="inline-block h-2 w-2 animate-bounce rounded-full bg-blue-400 [animation-delay:0ms]" />
                <span className="inline-block h-2 w-2 animate-bounce rounded-full bg-blue-400 [animation-delay:150ms]" />
                <span className="inline-block h-2 w-2 animate-bounce rounded-full bg-blue-400 [animation-delay:300ms]" />
              </div>
            ) : (
              <Typography variant="small" className="whitespace-pre-wrap text-blue-gray-800">
                {content}
              </Typography>
            )}
          </div>
        </div>

        {/* File results toggle */}
        {!isLoading && Array.isArray(files) && files.length > 0 && (
          <div className="ml-9">
            <button
              onClick={() => setExpanded((v) => !v)}
              className="flex items-center gap-1.5 rounded-full border border-blue-gray-200 bg-blue-gray-50 px-3 py-1 text-xs font-medium text-blue-gray-700 hover:bg-blue-gray-100 transition-colors"
            >
              {expanded ? (
                <ChevronUpIcon className="size-3.5" />
              ) : (
                <ChevronDownIcon className="size-3.5" />
              )}
              {expanded ? '收起' : '查看'} {matchCount}/{totalCount} 份符合檔案
            </button>

            {expanded && (
              <div className="mt-2 space-y-1.5">
                {files.map((f) => (
                  <FileResultCard key={f.fileId} file={f} currentUserId={currentUserId} />
                ))}
              </div>
            )}
          </div>
        )}

        {/* No result hint */}
        {!isLoading && matchCount === 0 && totalCount > 0 && (
          <div className="ml-9">
            <Typography variant="small" className="text-xs text-blue-gray-400">
              共 {totalCount} 份可搜尋檔案，無符合結果
            </Typography>
          </div>
        )}
      </div>
    </div>
  )
}

AgentMessageBubble.propTypes = {
  role: PropTypes.oneOf(['user', 'assistant']).isRequired,
  content: PropTypes.string,
  files: PropTypes.array,
  matchCount: PropTypes.number,
  totalCount: PropTypes.number,
  isLoading: PropTypes.bool,
  currentUserId: PropTypes.string
}

AgentMessageBubble.defaultProps = {
  content: '',
  files: [],
  matchCount: 0,
  totalCount: 0,
  isLoading: false,
  currentUserId: ''
}

export default AgentMessageBubble
