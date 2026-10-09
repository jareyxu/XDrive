import { testUsesHTTPS } from './tls-proxy.mjs'
import { selectListPreference } from './legacy-list-test'
import { expect, test, type Page } from './legacy-list-test'
import AxeBuilder from '@axe-core/playwright'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { startIsolatedServer } from './isolated-server'
const password = 'correct horse battery'
const nav = (page: Page, name: string) => page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name, exact: true })
async function setup(page: Page, url: string, token: string) {
 await page.goto(`${url}/setup#${token}`)
 await page.getByLabel('设置密码').fill(password); await page.getByLabel('再次输入密码').fill(password)
 await page.getByLabel('我已了解：如果忘记密码，云盘数据无法恢复。').check()
 await page.getByRole('button', { name: '创建加密云盘' }).click()
 await expect(page.getByRole('heading', { name: '我的文件', exact: true })).toBeVisible({timeout:30000})
}
async function upload(page: Page, name: string) {
 await expect(page.getByRole('button', { name: '上传', exact: true })).toBeEnabled()
 await page.locator('input[type="file"]:not([webkitdirectory])').first().setInputFiles({name,mimeType:'text/plain',buffer:Buffer.from(`bytes:${name}`)})
 await expect(page.getByRole('button',{name,exact:true})).toBeVisible()
}
async function trash(page:Page,name:string) {
 page.once('dialog',dialog=>void dialog.accept())
 await page.getByRole('button',{name:`移到回收站 ${name}`,exact:true}).click()
 await expect(page.getByRole('button',{name,exact:true})).toHaveCount(0)
}
async function seed(page:Page) {
 page.once('dialog',dialog=>void dialog.accept('tree'))
 await page.getByRole('button',{name:'新建文件夹',exact:true}).click()
 await page.getByRole('button',{name:'tree',exact:true}).click()
 await expect(page.getByRole('heading',{name:'tree',exact:true})).toBeVisible()
 await upload(page,'inside.txt')
 await nav(page,'我的文件').click()
 await upload(page,'loose.txt')
 await trash(page,'tree');await trash(page,'loose.txt')
}
async function unlock(page:Page,url:string) {
 await page.goto(`${url}/drive`);await page.getByLabel('密码',{exact:true}).fill(password)
 await page.getByRole('button',{name:'解锁云盘',exact:true}).click()
 await expect(page.getByRole('heading',{name:'我的文件',exact:true})).toBeVisible()
}
const confirm = (page:Page,count:number)=>page.getByRole('dialog',{name:'清空回收站',exact:true}).getByRole('button',{name:`永久删除这 ${count} 项`,exact:true})

test('clear confirmation cancels without writes and atomically purges its snapshot while retaining newly trashed roots',async({page,browserName,browser})=>{
 test.setTimeout(120000)
 const server=await startIsolatedServer(),context=await browser.newContext({ ignoreHTTPSErrors: testUsesHTTPS() })
 await selectListPreference(context)
 try {
  await setup(page,server.baseURL,server.token);await seed(page)
  await nav(page,'回收站').click()
  let writes=0
  page.on('request',request=>{if(['POST','PUT','DELETE'].includes(request.method()))writes++})
  const open=page.getByRole('button',{name:'清空回收站',exact:true})
  await open.click();await expect(confirm(page,2)).toBeVisible()
  await expect(page.getByRole('dialog',{name:'清空回收站'})).toContainText('此操作无法恢复')
  await expect(page.getByRole('dialog',{name:'清空回收站'}).getByRole('button',{name:'取消',exact:true})).toBeFocused()
  await page.keyboard.press('Shift+Tab');await expect(confirm(page,2)).toBeFocused()
  await page.keyboard.press('Tab');await expect(page.getByRole('dialog',{name:'清空回收站'}).getByRole('button',{name:'取消',exact:true})).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog',{name:'清空回收站'})).toHaveCount(0);await expect(open).toBeFocused();expect(writes).toBe(0)
  await nav(page,'存储空间').click()
  await page.getByRole('button',{name:/^清空回收站 · 占用/u}).click()
  await page.setViewportSize({width:390,height:844})
  const audit=await new AxeBuilder({page}).include('dialog[open]').analyze()
  expect(audit.violations.filter(issue=>issue.impact==='critical'||issue.impact==='serious')).toEqual([])
  const artifacts=join(import.meta.dirname,'..','..','docs','operations','artifacts','clear-trash-2026-09-30',browserName);mkdirSync(artifacts,{recursive:true})
  await page.screenshot({path:join(artifacts,'light.png')})
  await page.evaluate(()=>{document.documentElement.dataset.theme='dark'})
  const darkAudit=await new AxeBuilder({page}).include('dialog[open]').analyze()
  expect(darkAudit.violations.filter(issue=>issue.impact==='critical'||issue.impact==='serious')).toEqual([])
  for(const button of await page.getByRole('dialog',{name:'清空回收站'}).getByRole('button').all()){const box=await button.boundingBox();expect(box!.height).toBeGreaterThanOrEqual(44);expect(box!.width).toBeGreaterThanOrEqual(44)}
  await page.screenshot({path:join(artifacts,'dark.png')})
  writeFileSync(join(artifacts,'accessibility.json'),JSON.stringify({browser:browserName,physicalDevice:false,viewport:{width:390,height:844},light:audit.violations,dark:darkAudit.violations},null,2))
  await context.addCookies(await page.context().cookies());const other=await context.newPage();await unlock(other,server.baseURL)
  await upload(other,'later.txt');await trash(other,'later.txt')
  const bulk:number[]=[]
  page.on('request',request=>{if(request.url().endsWith('/metadata/transactions')) {const body=request.postDataJSON() as {purgeTombstoneIds?:string[]};if(body.purgeTombstoneIds)bulk.push(body.purgeTombstoneIds.length)}})
  await confirm(page,2).click()
  await expect(page.getByRole('status')).toContainText('期间新移入的项目仍在回收站')
  expect(bulk).toEqual([2])
  await nav(page,'回收站').click()
  await expect(page.getByRole('button',{name:'tree',exact:true})).toHaveCount(0)
  await expect(page.getByRole('button',{name:'loose.txt',exact:true})).toHaveCount(0)
  await page.getByRole('button',{name:'later.txt',exact:true}).click()
  await expect(page.getByRole('dialog',{name:'预览 later.txt'})).toContainText('bytes:later.txt')
  await page.getByRole('button',{name:'关闭预览'}).click()
  await open.click();await confirm(page,1).click()
  await expect(page.getByRole('heading',{name:'回收站为空'})).toBeVisible()
  const usage=await page.evaluate(async()=> (await (await fetch('/api/v1/storage/usage')).json()))
  expect(usage.trashBytes).toBe(0);expect(usage.pendingBytes).toBe(0);expect(usage.uploadReservedBytes).toBe(0)
  expect(bulk).toEqual([2,1])
 }finally{await context.close();await server.close()}
})

test('a remote restore racing the final clear transaction leaves remaining trash intact and releases rejected metadata',async({page,browser})=>{
 test.setTimeout(120000)
 const server=await startIsolatedServer(),context=await browser.newContext({ ignoreHTTPSErrors: testUsesHTTPS() })
 await selectListPreference(context)
 try {
  await setup(page,server.baseURL,server.token);await seed(page)
  await context.addCookies(await page.context().cookies());const other=await context.newPage();await unlock(other,server.baseURL);await nav(other,'回收站').click()
  await nav(page,'回收站').click();await page.getByRole('button',{name:'清空回收站',exact:true}).click()
  let requests=0
  await page.route('**/api/v1/metadata/transactions',async route=>{
   if((route.request().postDataJSON() as {purgeTombstoneIds?:unknown}).purgeTombstoneIds){requests++;await other.getByRole('button',{name:'恢复 tree',exact:true}).click();await expect(other.getByRole('button',{name:'tree',exact:true})).toHaveCount(0)}
   await route.continue()
  })
  await confirm(page,2).click()
  await expect(page.getByRole('alert')).toContainText('请刷新后重新确认')
  expect(requests).toBe(1)
  await expect(page.getByRole('button',{name:'tree',exact:true})).toHaveCount(0)
  await expect(page.getByRole('button',{name:'loose.txt',exact:true})).toBeVisible()
  const usage=await page.evaluate(async()=> (await (await fetch('/api/v1/storage/usage')).json()))
  expect(usage.pendingBytes).toBe(0);expect(usage.uploadReservedBytes).toBe(0);expect(usage.trashBytes).toBeGreaterThan(0)
  await nav(page,'我的文件').click();await page.getByRole('button',{name:'tree',exact:true}).click()
  await expect(page.getByRole('heading',{name:'tree',exact:true})).toBeVisible()
  await page.getByRole('button',{name:'inside.txt',exact:true}).click()
  await expect(page.getByRole('dialog',{name:'预览 inside.txt'})).toContainText('bytes:inside.txt')
 }finally{await context.close();await server.close()}
})

test('locking while clear waits for its final transaction aborts the owner and cannot resurrect plaintext or widen deletion',async({page})=>{
 test.setTimeout(120000)
 const server=await startIsolatedServer()
 let release=()=>{},reached=()=>{},finished=()=>{}
 const held=new Promise<void>(resolve=>{release=resolve}),waiting=new Promise<void>(resolve=>{reached=resolve}),done=new Promise<void>(resolve=>{finished=resolve})
 try {
  await setup(page,server.baseURL,server.token);await seed(page);await nav(page,'回收站').click()
  await page.route('**/api/v1/metadata/transactions',async route=>{
   reached();await held
   try{await route.continue()}catch{/* The browser has cancelled its owner's request. */}finally{finished()}
  })
  await page.getByRole('button',{name:'清空回收站',exact:true}).click();await confirm(page,2).click();await waiting
  await page.getByRole('button',{name:'锁定云盘',exact:true}).click()
  await expect(page.getByRole('button',{name:'解锁云盘',exact:true})).toBeVisible()
  await expect(page.getByRole('dialog',{name:'清空回收站'})).toHaveCount(0)
  expect(await page.locator('body').innerText()).not.toMatch(/loose\.txt|inside\.txt/u)
  release();await done
  await page.getByLabel('密码',{exact:true}).fill(password);await page.getByRole('button',{name:'解锁云盘',exact:true}).click()
  await expect(page.getByRole('button',{name:'tree',exact:true})).toBeVisible()
  await expect(page.getByRole('button',{name:'loose.txt',exact:true})).toBeVisible()
  await expect.poll(()=>page.evaluate(async()=> (await (await fetch('/api/v1/storage/usage')).json()).pendingBytes)).toBe(0)
  expect(await page.evaluate(async()=> (await (await fetch('/api/v1/storage/usage')).json()).uploadReservedBytes)).toBe(0)
 }finally{release();await server.close()}
})
