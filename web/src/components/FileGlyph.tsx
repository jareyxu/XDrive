import { useId } from 'react'

/** Local artwork: no remote icons or user file data in SVG identifiers. */
export function FileGlyph({ kind, name = '' }: { kind: 'folder' | 'file'; name?: string }) {
  const gradient = useId()
  const extension = name.split('.').at(-1)?.toLowerCase() ?? ''
  const label = /^(pdf|xlsx?|docx?|pptx?|zip|txt|md|mp4|mov|heic|png|jpe?g)$/.test(extension) ? extension.toUpperCase().slice(0, 4) : ''
  const color = extension === 'pdf' ? '#e54b56' : /^xlsx?$/.test(extension) ? '#269d6f' : /^pptx?$/.test(extension) ? '#e9893d' : '#558bd1'
  return kind === 'folder' ? <svg className="file-glyph folder-glyph" viewBox="0 0 96 80" fill="none" aria-hidden="true">
    <defs><linearGradient id={gradient} x1="48" y1="10" x2="48" y2="76" gradientUnits="userSpaceOnUse"><stop stopColor="#8ac8ff" /><stop offset="1" stopColor="#3695f6" /></linearGradient></defs>
    <path d="M6 17a9 9 0 0 1 9-9h20l10 11h36a9 9 0 0 1 9 9v37a9 9 0 0 1-9 9H15a9 9 0 0 1-9-9V17Z" fill="#2685e7" />
    <path d="M7 28a8 8 0 0 1 8-8h66a9 9 0 0 1 9 9v36a9 9 0 0 1-9 9H15a8 8 0 0 1-8-8V28Z" fill={`url(#${gradient})`} stroke="#60afff" />
    <path d="M16 21h63" stroke="#c4e6ff" strokeLinecap="round" />
  </svg> : <svg className="file-glyph document-glyph" viewBox="0 0 80 96" fill="none" aria-hidden="true">
    <path d="M14 3h35l20 20v63a7 7 0 0 1-7 7H14a7 7 0 0 1-7-7V10a7 7 0 0 1 7-7Z" fill="#f5f7fc" stroke="#dce2ed" />
    <path d="M49 3v15a5 5 0 0 0 5 5h15" fill="#dfe5ef" />
    <path d="M23 40h30M23 48h30M23 56h20" stroke="#b2bdcf" strokeWidth="4" strokeLinecap="round" />
    <rect x="17" y="65" width="47" height="20" rx="5" fill={color} />
    <text x="40.5" y="79" textAnchor="middle" fill="white" fontFamily="system-ui, sans-serif" fontWeight="700" fontSize="11">{label || 'FILE'}</text>
  </svg>
}
