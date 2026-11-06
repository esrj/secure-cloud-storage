/**
 * 智慧分類／LM 分析中的旋轉指示（純 CSS）。
 */
export default function AnalysisSpinner({ className = '' }) {
  return (
    <span
      role="status"
      aria-label="載入中"
      className={`inline-block h-5 w-5 shrink-0 animate-spin rounded-full border-2 border-blue-gray-200 border-t-blue-600 ${className}`}
    />
  )
}
