/**
 * Admin-only page: list every user and download their smart-search
 * conversation history as a JSON file.
 *
 * The server enforces the admin role; this page is simply hidden from
 * normal users by NavBar.
 */
import { useEffect, useState, useCallback } from 'react'
import { Typography, Button, Chip, Spinner } from '@material-tailwind/react'
import { ArrowDownTrayIcon, ArrowPathIcon } from '@heroicons/react/24/outline'
import toast from 'react-hot-toast'

const ROLE_LABEL = { admin: '管理員', user: '使用者' }
const STATUS_LABEL = { activate: '啟用', stopped: '停用', deleted: '已刪除' }
// Fixed column widths (table-fixed) so the table fits the default 1024px
// window (nav bar 320px + page padding). Only the first column is fluid.
const HEADERS = [
  { text: '使用者', className: '' },
  { text: '角色', className: 'w-[4.5rem]' },
  { text: '狀態', className: 'w-[4.5rem]' },
  { text: '註冊時間', className: 'w-28' },
  { text: '檔案數', className: 'w-14' },
  { text: '動作', className: 'w-[8.5rem]' }
]

function formatTime(value) {
  if (!value) return '—'
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? String(value) : d.toLocaleString('zh-TW', { hour12: false })
}

export default function AdminUsersPage() {
  const [users, setUsers] = useState([])
  const [loading, setLoading] = useState(false)
  const [exportingId, setExportingId] = useState(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await window.electronAPI.adminListUsers()
      if (!res?.ok) throw new Error(res?.error || '未知錯誤')
      setUsers(res.users)
    } catch (e) {
      toast.error(`載入使用者列表失敗：${e.message}`)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  async function exportConversations(user) {
    setExportingId(user.id)
    try {
      const res = await window.electronAPI.adminExportConversations({
        userId: user.id,
        userName: user.name
      })
      if (!res?.ok) throw new Error(res?.error || '未知錯誤')
      if (res.canceled) return
      toast.success(`已儲存 ${res.count} 則訊息至 ${res.path}`)
    } catch (e) {
      toast.error(`下載對話紀錄失敗：${e.message}`)
    } finally {
      setExportingId(null)
    }
  }

  return (
    <div className="flex h-full w-full min-w-0 flex-col overflow-hidden">
      <div className="flex shrink-0 items-center justify-between gap-4 border-b border-blue-gray-100 bg-white px-5 py-3">
        <div className="min-w-0">
          <Typography variant="h6" className="text-blue-gray-900">
            使用者管理
          </Typography>
          <Typography variant="small" color="gray" className="text-xs">
            管理員專用・可下載任一使用者的智慧搜尋對話紀錄（JSON）
          </Typography>
        </div>
        <Button
          size="sm"
          variant="outlined"
          color="blue-gray"
          className="flex shrink-0 items-center gap-1 whitespace-nowrap"
          onClick={() => void load()}
          disabled={loading}
        >
          <ArrowPathIcon className="size-4" />
          重新整理
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-auto px-5 py-4">
        {loading && users.length === 0 ? (
          <div className="flex items-center gap-2 text-blue-gray-500">
            <Spinner className="size-4" /> 載入中…
          </div>
        ) : (
          <table className="w-full table-fixed text-left">
            <thead>
              <tr>
                {HEADERS.map((h) => (
                  <th
                    key={h.text}
                    className={`border-b border-blue-gray-100 bg-blue-gray-50 px-2 py-3 ${h.className}`}
                  >
                    <Typography
                      variant="small"
                      className="whitespace-nowrap text-xs font-bold text-blue-gray-700"
                    >
                      {h.text}
                    </Typography>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id} className="border-b border-blue-gray-50 hover:bg-blue-gray-50/50">
                  <td className="px-2 py-3 align-top">
                    <Typography
                      variant="small"
                      className="truncate font-medium text-blue-gray-900"
                      title={u.name || ''}
                    >
                      {u.name || '(未知)'}
                    </Typography>
                    <Typography
                      variant="small"
                      className="truncate text-xs text-blue-gray-600"
                      title={u.email || ''}
                    >
                      {u.email || '—'}
                    </Typography>
                    <Typography
                      variant="small"
                      className="truncate font-mono text-[10px] text-blue-gray-400"
                      title={u.id}
                    >
                      {u.id}
                    </Typography>
                  </td>
                  <td className="px-2 py-3 align-top">
                    <Chip
                      value={ROLE_LABEL[u.role] || u.role}
                      size="sm"
                      color={u.role === 'admin' ? 'blue' : 'blue-gray'}
                      variant="ghost"
                      className="w-fit"
                    />
                  </td>
                  <td className="px-2 py-3 align-top">
                    <Chip
                      value={STATUS_LABEL[u.status] || u.status}
                      size="sm"
                      color={u.status === 'activate' ? 'green' : 'red'}
                      variant="ghost"
                      className="w-fit"
                    />
                  </td>
                  <td className="px-2 py-3 align-top">
                    {formatTime(u.timestamp)
                      .split(' ')
                      .map((part, i) => (
                        <Typography
                          key={i}
                          variant="small"
                          className="whitespace-nowrap text-xs leading-snug text-blue-gray-700"
                        >
                          {part}
                        </Typography>
                      ))}
                  </td>
                  <td className="px-2 py-3 align-top">
                    <Typography variant="small">{u.fileCount ?? 0}</Typography>
                  </td>
                  <td className="px-2 py-3 align-top">
                    <Button
                      size="sm"
                      variant="outlined"
                      color="blue-gray"
                      className="flex items-center gap-1 whitespace-nowrap px-2"
                      onClick={() => void exportConversations(u)}
                      disabled={exportingId !== null}
                    >
                      {exportingId === u.id ? (
                        <Spinner className="size-3.5" />
                      ) : (
                        <ArrowDownTrayIcon className="size-4" />
                      )}
                      下載對話紀錄
                    </Button>
                  </td>
                </tr>
              ))}
              {users.length === 0 && !loading && (
                <tr>
                  <td colSpan={HEADERS.length} className="p-6 text-center">
                    <Typography variant="small" color="gray">
                      目前沒有使用者
                    </Typography>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
