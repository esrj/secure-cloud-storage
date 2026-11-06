/**
 * This component show the logs from main process
 */
import { Card, Typography } from '@material-tailwind/react'
import { useState, useEffect, useRef } from 'react'

function Console() {
  const [logs, setLogs] = useState([])
  const logsRef = useRef([])

  useEffect(() => {
    window.electronAPI.onLog((result) => {
      setLogs((prevLogs) => [...prevLogs, { ...result, id: prevLogs.length }])
      //? limit the total number of logs? (remove the oldest one)
    })
  }, [])

  useEffect(() => {
    if (logsRef.current.length > 0) {
      logsRef.current.at(-1).scrollIntoView({ block: 'end', behavior: 'smooth' })
    }
  }, [logs])

  const getColorForLevel = (level) => {
    switch (level) {
      case 'info':
        return 'blue-gray'
      case 'warn':
        return 'orange'
      case 'error':
        return 'red'
      default:
        return 'blue-gray'
    }
  }

  return (
    <Card className="h-36 min-h-36 w-full p-4 border-2 overflow-auto justify-start">
      {logs.map((log, index) => (
        <Typography
          ref={(el) => (logsRef.current[index] = el)}
          className="w-full h-full text-left whitespace-pre-wrap break-all"
          key={log.id}
          color={getColorForLevel(log.level)}
        >
          {log.message + '\n'}
        </Typography>
      ))}
    </Card>
  )
}

export default Console
