/**
 * This file is the parent of all other components
 */
import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import NavBar, { PageType } from './components/NavBar.jsx'
import MainView from './components/MainView.jsx'
import Console from './components/Console.jsx'
import {
  ProfileContext,
  PageContext,
  SearchContext,
  RequestContext,
  GlobalAttrsContext,
  AgentChatContext
} from './components/Contexts.jsx'
import { WELCOME } from './components/AgentPage.jsx'
import toast, { Toaster } from 'react-hot-toast'
import { ResponseType, SearchType } from './components/Types.jsx'

function App() {
  const [pageType, setPageType] = useState(PageType.file)
  const [storedName, setStoredName] = useState('')
  const [storedEmail, setStoredEmail] = useState('')
  const [loggedIn, setLoggedIn] = useState(false)
  const [userId, setUserId] = useState('')
  const [role, setRole] = useState('user')
  const [searchType, setSearchType] = useState(SearchType.name)
  const [searchTerm, setSearchTerm] = useState('')
  const [publicSearchTerm, setPublicSearchTerm] = useState('')
  const [searchTimes, setSearchTimes] = useState(0)
  const [requestList, setRequestList] = useState([])
  const [requestedList, setRequestedList] = useState([])
  const [seenRequests, setSeenRequests] = useState(0)
  const [seenReplies, setSeenReplies] = useState(0)
  const [globalAttrs, setGlobalAttrs] = useState([])
  // Agent chat: lifted here so the conversation survives page switches
  const [agentMessages, setAgentMessages] = useState([WELCOME])
  const agentHistoryRef = useRef([])
  const agentConversationIdRef = useRef(crypto.randomUUID())
  const agentHistoryLoadedForRef = useRef('')

  const login = useCallback(() => {
    window.electronAPI
      .askLogin()
      .then((userInfo) => {
        if (userInfo) {
          setStoredName(userInfo.name)
          setStoredEmail(userInfo.email)
          setUserId(userInfo.userId)
          setRole(userInfo.role === 'admin' ? 'admin' : 'user')
          toast.success('Login success')
        }
      })
      .catch((error) => {
        toast.error(`Login error: ${error.message}`)
      })
  }, [])

  const profileContextValue = useMemo(
    () => ({
      storedNameC: [storedName, setStoredName],
      storedEmailC: [storedEmail, setStoredEmail],
      userIdC: [userId, setUserId],
      roleC: [role, setRole],
      login: login,
      loggedIn
    }),
    [storedName, storedEmail, userId, role]
  )
  const requestContextValue = useMemo(
    () => ({
      requestListC: [requestList, setRequestList],
      requestedListC: [requestedList, setRequestedList]
    }),
    [requestList, requestedList]
  )
  const searchContextValue = useMemo(
    () => ({
      searchTypeC: [searchType, setSearchType],
      searchTermC: [searchTerm, setSearchTerm],
      publicSearchTermC: [publicSearchTerm, setPublicSearchTerm],
      searchTimesC: [searchTimes, setSearchTimes]
    }),
    [searchType, searchTerm, publicSearchTerm, searchTimes]
  )
  const globalAttrsContextValue = useMemo(
    () => ({
      globalAttrs: globalAttrs
    }),
    [globalAttrs]
  )
  const pageContextValue = useMemo(() => [pageType, swapPageHandler], [pageType])
  const agentChatContextValue = useMemo(
    () => ({
      messagesC: [agentMessages, setAgentMessages],
      historyC: agentHistoryRef,
      conversationIdC: agentConversationIdRef
    }),
    [agentMessages]
  )

  useEffect(() => {
    window.electronAPI.onNotice((result, level) => {
      if (level === 'error') {
        toast.error(result)
      } else if (level === 'success') {
        toast.success(result)
      } else {
        toast(result)
      }
    })
    window.electronAPI.onUserConfig(({ name, email, userId, role }) => {
      setStoredName(name)
      setStoredEmail(email)
      setUserId(userId)
      setRole(role === 'admin' ? 'admin' : 'user')
    })
    window.electronAPI.onLoginStatus(({ loggedIn }) => {
      setLoggedIn(loggedIn)
    })
    window.electronAPI.onRequestValue(({ seenRequests, seenReplies }) => {
      setSeenRequests(seenRequests)
      setSeenReplies(seenReplies)
    })
    window.electronAPI.onGlobalAttrs(({ globalAttrs }) => {
      setGlobalAttrs(globalAttrs)
    })
  }, [])

  // Restore the most recent smart-search conversation from the server once per
  // login so the chat survives restarts. Never clobbers an active chat.
  // The restored turns are shown and fed back to the model as context, but the
  // conversation id is NOT adopted: every login opens a new server-side
  // conversation, so the audit log stays segmented per session instead of
  // growing into one record that spans days.
  useEffect(() => {
    if (!userId || agentHistoryLoadedForRef.current === userId) return
    agentHistoryLoadedForRef.current = userId
    let cancelled = false
    void (async () => {
      try {
        const res = await window.electronAPI.agentMyHistory?.({ limit: 1 })
        const conv = res?.ok ? res.conversations?.[0] : null
        if (cancelled || !conv || !Array.isArray(conv.messages) || conv.messages.length === 0) return
        if (agentHistoryRef.current.length > 0) return
        const restored = conv.messages.map((m) => ({
          id: m.id,
          role: m.role === 'user' ? 'user' : 'assistant',
          content: m.content,
          files: [],
          matchCount: 0,
          totalCount: 0
        }))
        agentHistoryRef.current = conv.messages
          .map((m) => ({ role: m.role, content: m.content }))
          .slice(-12)
        setAgentMessages([WELCOME, ...restored])
      } catch (e) {
        console.warn('[App] agent history restore failed:', e)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [userId])

  function swapPageHandler(newPageType) {
    if (newPageType === PageType.reply) {
      window.electronAPI.updateRequestValue({
        seenRequests: seenRequests,
        seenReplies: requestList.filter((file) => file.status !== ResponseType.N).length
      })
      setSeenReplies(requestList.filter((file) => file.status !== ResponseType.N).length)
    }
    if (newPageType === PageType.request) {
      window.electronAPI.updateRequestValue({
        seenRequests: requestedList.length,
        seenReplies: seenReplies
      })
      setSeenRequests(requestedList.length)
    }
    setSearchTerm('')
    switch (newPageType) {
      case PageType.public:
        setSearchType(SearchType.name)
        break
      case PageType.file:
        setSearchType(SearchType.name)
        break
      case PageType.reply:
        setSearchType(SearchType.fileId)
        window.electronAPI.askRequestList()
        break
      case PageType.request:
        window.electronAPI.askRequestedList()
        setSearchType(SearchType.fileId)
        break
      default:
        break
    }
    setPageType(newPageType)
  }

  return (
    <>
      <Toaster
        position="bottom-left"
        containerClassName="font-sans"
        reverseOrder={false}
        containerStyle={{ zIndex: 99999 }}
      />
      <ProfileContext.Provider value={profileContextValue}>
        <PageContext.Provider value={pageContextValue}>
          <RequestContext.Provider value={requestContextValue}>
            <SearchContext.Provider value={searchContextValue}>
              <GlobalAttrsContext.Provider value={globalAttrsContextValue}>
                <AgentChatContext.Provider value={agentChatContextValue}>
                <div className="flex flex-row h-screen w-screen justify-center">
                  <NavBar
                    pageType={pageType}
                    setPageType={swapPageHandler}
                    seenRequest={seenRequests}
                    seenReply={seenReplies}
                  />
                  <div className="flex min-w-0 flex-col grow">
                    <MainView />
                    <Console />
                  </div>
                </div>
                </AgentChatContext.Provider>
              </GlobalAttrsContext.Provider>
            </SearchContext.Provider>
          </RequestContext.Provider>
        </PageContext.Provider>
      </ProfileContext.Provider>
    </>
  )
}

export default App
