import hljs from 'highlight.js/lib/core'
import javascript from 'highlight.js/lib/languages/javascript'
import typescript from 'highlight.js/lib/languages/typescript'
import json from 'highlight.js/lib/languages/json'
import xml from 'highlight.js/lib/languages/xml'
import css from 'highlight.js/lib/languages/css'
import go from 'highlight.js/lib/languages/go'
import python from 'highlight.js/lib/languages/python'
import bash from 'highlight.js/lib/languages/bash'
import yaml from 'highlight.js/lib/languages/yaml'
import ini from 'highlight.js/lib/languages/ini'
import c from 'highlight.js/lib/languages/c'
import cpp from 'highlight.js/lib/languages/cpp'
import csharp from 'highlight.js/lib/languages/csharp'
import java from 'highlight.js/lib/languages/java'
import rust from 'highlight.js/lib/languages/rust'
import ruby from 'highlight.js/lib/languages/ruby'
import php from 'highlight.js/lib/languages/php'
import sql from 'highlight.js/lib/languages/sql'
import swift from 'highlight.js/lib/languages/swift'
import kotlin from 'highlight.js/lib/languages/kotlin'
import graphql from 'highlight.js/lib/languages/graphql'
import dockerfile from 'highlight.js/lib/languages/dockerfile'
import makefile from 'highlight.js/lib/languages/makefile'
import { parseHighlightRanges } from '../media/highlight-ranges'

for (const [name, grammar] of Object.entries({ javascript, typescript, json, xml, css, go, python, bash, yaml, ini, c, cpp, csharp, java, rust, ruby, php, sql, swift, kotlin, graphql, dockerfile, makefile })) hljs.registerLanguage(name, grammar)
self.onmessage = (event: MessageEvent<{ source: string; language: string }>) => {
  try {
    const { source, language } = event.data
    if (typeof source !== 'string' || source.length > 20 * 1024 * 1024 || !hljs.getLanguage(language)) throw new TypeError('invalid highlight input')
    const result = parseHighlightRanges(source, hljs.highlight(source, { language, ignoreIllegals: true }).value)
    self.postMessage({ ok: true, ...result }, { transfer: [result.ranges.buffer] })
  } catch { self.postMessage({ ok: false }) }
}
