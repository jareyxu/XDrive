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
 await expect(page.getByRole('button', { name: '\u4e0a\u4f20', exact: true })).toBeEnabled()
 await page.locator('input[type="file"]:not([webkitdirectory])').first().setInputFiles({name,mimeType:'text/plain',buffer:Buffer.from(`bytes:${name}`)})
 await expect(page.getByRole('button',{name,exact:true})).toBeVisible()
}
async function folder(page:Page,name:string) {
 page.once('dialog',dialog=>void dialog.accept(name));await page.getByRole('button',{name:'新建文件夹',exact:true}).click()
 await expect(page.getByRole('button',{name,exact:true})).toBeVisible()
}
async function trash(page:Page,name:string) {
 page.once('dialog',dialog=>void dialog.accept());await page.getByRole('button',{name:`移到回收站 ${name}`,exact:true}).click()
 await expect(page.getByRole('button',{name,exact:true})).toHaveCount(0)
}
const choose=(page:Page,name:string)=>page.getByRole('checkbox',{name:`选择回收站 ${name}`,exact:true})

test('selected roots purge only the confirmed subset; descendants have no independent selection',async({page,browserName})=>{
 test.setTimeout(120000);const server=await startIsolatedServer()
 try {
  await setup(page,server.baseURL,server.token);await folder(page,'tree');await page.getByRole('button',{name:'tree',exact:true}).click();await expect(page.getByRole('heading',{name:'tree',exact:true})).toBeVisible()
  await upload(page,'inside.txt');await nav(page,'我的文件').click()
  await upload(page,'one.txt');await upload(page,'keep.txt');await trash(page,'tree');await trash(page,'one.txt');await trash(page,'keep.txt')
  await nav(page,'回收站').click();await page.getByRole('button',{name:'tree',exact:true}).click()
  await expect(page.getByRole('button',{name:'inside.txt',exact:true})).toBeVisible()
  await expect(page.getByRole('checkbox')).toHaveCount(0);await expect(page.getByRole('toolbar',{name:'回收站批量操作'})).toHaveCount(0)
  await expect(page.getByRole('button',{name:'恢复 inside.txt',exact:true})).toHaveCount(0)
  await nav(page,'回收站').click();await choose(page,'tree').check();await choose(page,'one.txt').check()
  let writes=0;const batches:number[]=[]
  page.on('request',r=>{if(['POST','PUT','DELETE'].includes(r.method()))writes++;if(r.url().endsWith('/metadata/transactions')){const ids=r.postDataJSON().purgeTombstoneIds as string[]|undefined;if(ids)batches.push(ids.length)}})
  await page.getByRole('button',{name:'永久删除所选',exact:true}).click()
  const dialog=page.getByRole('dialog',{name:'永久删除所选项目',exact:true})
  await expect(dialog.getByRole('button',{name:'取消',exact:true})).toBeFocused();await page.keyboard.press('Escape')
  await expect(page.getByRole('button',{name:'永久删除所选',exact:true})).toBeFocused();expect(writes).toBe(0)
  await page.setViewportSize({width:390,height:844})
  const audit=await new AxeBuilder({page}).include('[aria-label="回收站批量操作"]').include('.trash-root-row').analyze()
  expect(audit.violations.filter(v=>v.impact==='serious'||v.impact==='critical')).toEqual([])
  const artifacts=join(import.meta.dirname,'..','..','docs','operations','artifacts','trash-selection-2026-10-01',browserName);mkdirSync(artifacts,{recursive:true})
  await page.screenshot({path:join(artifacts,'selection-mobile.png')})
  for(const target of await page.locator('.trash-choice, .trash-batch-actions button').all()) {const box=await target.boundingBox();expect(box!.width).toBeGreaterThanOrEqual(44);expect(box!.height).toBeGreaterThanOrEqual(44)}
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true)
  writeFileSync(join(artifacts,'accessibility.json'),JSON.stringify({browser:browserName,physicalDevice:false,viewport:{width:390,height:844},violations:audit.violations},null,2))
  await page.getByRole('button',{name:'永久删除所选',exact:true}).click();await dialog.getByRole('button',{name:'永久删除这 2 项',exact:true}).click()
  await expect(page.getByRole('status')).toContainText('未选项目保留');expect(batches).toEqual([2])
  await expect(choose(page,'keep.txt')).toBeVisible();await expect(choose(page,'one.txt')).toHaveCount(0);await expect(choose(page,'tree')).toHaveCount(0)
  await page.getByRole('button',{name:'keep.txt',exact:true}).click();await expect(page.getByRole('dialog',{name:'预览 keep.txt'})).toContainText('bytes:keep.txt')
 }finally{await server.close()}
})

test('batch restore joins separately deleted child to its original restored parent in one transaction',async({page})=>{
 test.setTimeout(120000);const server=await startIsolatedServer()
 try {
  await setup(page,server.baseURL,server.token);await folder(page,'parent');await page.getByRole('button',{name:'parent',exact:true}).click();await expect(page.getByRole('heading',{name:'parent',exact:true})).toBeVisible()
  await upload(page,'child.txt');await upload(page,'sibling.txt');await trash(page,'child.txt');await nav(page,'我的文件').click();await trash(page,'parent')
  await upload(page,'keep.txt');await trash(page,'keep.txt');await nav(page,'回收站').click()
  await choose(page,'child.txt').check();await choose(page,'parent').check()
  const batches:number[]=[];page.on('request',r=>{if(r.url().endsWith('/metadata/transactions')){const ids=r.postDataJSON().restoreTombstoneIds as string[]|undefined;if(ids)batches.push(ids.length)}})
  await page.getByRole('button',{name:'恢复所选',exact:true}).click();await expect(page.getByRole('status')).toContainText('已原子恢复 2 个顶层项目')
  expect(batches).toEqual([2]);await expect(choose(page,'keep.txt')).toBeVisible();await expect(choose(page,'parent')).toHaveCount(0)
  await nav(page,'我的文件').click();await expect(page.getByRole('button',{name:'parent',exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'parent (1)',exact:true})).toHaveCount(0)
  await page.getByRole('button',{name:'parent',exact:true}).click();await expect(page.getByRole('heading',{name:'parent',exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'sibling.txt',exact:true})).toBeVisible()
  await page.getByRole('button',{name:'child.txt',exact:true}).click();await expect(page.getByRole('dialog',{name:'预览 child.txt'})).toContainText('bytes:child.txt')
  const usage=await page.evaluate(async()=> (await (await fetch('/api/v1/storage/usage')).json()));expect(usage.pendingBytes).toBe(0);expect(usage.uploadReservedBytes).toBe(0)
 }finally{await server.close()}
})

test('batch restore conflict has no partial writes, cancel retains selection, keep both restores entire set',async({page})=>{
 test.setTimeout(120000);const server=await startIsolatedServer()
 try {
  await setup(page,server.baseURL,server.token);await upload(page,'a.txt');await upload(page,'b.txt');await trash(page,'a.txt');await trash(page,'b.txt');await upload(page,'b.txt')
  await nav(page,'回收站').click();await choose(page,'a.txt').check();await choose(page,'b.txt').check()
  let writes=0;const batches:number[]=[];page.on('request',r=>{if(['POST','PUT','DELETE'].includes(r.method()))writes++;if(r.url().endsWith('/metadata/transactions')){const ids=r.postDataJSON().restoreTombstoneIds as string[]|undefined;if(ids)batches.push(ids.length)}})
  await page.getByRole('button',{name:'恢复所选',exact:true}).click()
  const dialog=page.getByRole('dialog',{name:'恢复名称冲突',exact:true});await expect(dialog).toContainText('本次尚未恢复任何项目')
  await expect(dialog.getByRole('button',{name:'取消恢复',exact:true})).toBeFocused();expect(writes).toBe(0)
  await page.keyboard.press('Shift+Tab');await expect(dialog.getByRole('button',{name:'关闭恢复冲突对话框',exact:true})).toBeFocused()
  await page.keyboard.press('Shift+Tab');await expect(dialog.getByRole('button',{name:'保留两者并恢复',exact:true})).toBeFocused()
  await page.keyboard.press('Tab');await expect(dialog.getByRole('button',{name:'关闭恢复冲突对话框',exact:true})).toBeFocused()
  await page.keyboard.press('Escape');await expect(choose(page,'a.txt')).toBeChecked();await expect(choose(page,'b.txt')).toBeChecked()
  await page.getByRole('button',{name:'恢复所选',exact:true}).click();await dialog.getByRole('button',{name:'保留两者并恢复',exact:true}).click()
  await expect(page.getByRole('heading',{name:'回收站为空',exact:true})).toBeVisible();expect(batches).toEqual([2])
  await nav(page,'我的文件').click();await expect(page.getByRole('button',{name:'a.txt',exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'b.txt',exact:true})).toBeVisible()
  await page.getByRole('button',{name:'b (1).txt',exact:true}).click();await expect(page.getByRole('dialog',{name:'预览 b (1).txt'})).toContainText('bytes:b.txt')
 }finally{await server.close()}
})

test('a remote restore during batch commit rolls back the other selected root and reconciles selection',async({page,browser})=>{
 test.setTimeout(120000);const server=await startIsolatedServer(),context=await browser.newContext({ ignoreHTTPSErrors: testUsesHTTPS() })
 await selectListPreference(context)
 try {
  await setup(page,server.baseURL,server.token);await upload(page,'one.txt');await upload(page,'two.txt');await trash(page,'one.txt');await trash(page,'two.txt');await nav(page,'回收站').click()
  await context.addCookies(await page.context().cookies());const other=await context.newPage();await other.goto(`${server.baseURL}/drive`)
  await other.getByLabel('密码',{exact:true}).fill(password);await other.getByRole('button',{name:'解锁云盘',exact:true}).click();await expect(other.getByRole('heading',{name:'我的文件',exact:true})).toBeVisible();await nav(other,'回收站').click()
  await choose(page,'one.txt').check();await choose(page,'two.txt').check();let attempts=0
  await page.route('**/api/v1/metadata/transactions',async route=>{
   if(route.request().postDataJSON().restoreTombstoneIds){attempts++;await other.getByRole('button',{name:'恢复 one.txt',exact:true}).click();await expect(choose(other,'one.txt')).toHaveCount(0)}
   await route.continue()
  })
  await page.getByRole('button',{name:'恢复所选',exact:true}).click();await expect(page.getByRole('alert')).toContainText('其余项目未恢复')
  await expect(choose(page,'one.txt')).toHaveCount(0);await expect(choose(page,'two.txt')).toBeChecked();expect(attempts).toBe(1)
  const usage=await page.evaluate(async()=> (await (await fetch('/api/v1/storage/usage')).json()));expect(usage.pendingBytes).toBe(0);expect(usage.uploadReservedBytes).toBe(0)
  await nav(page,'我的文件').click();await expect(page.getByRole('button',{name:'one.txt',exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'two.txt',exact:true})).toHaveCount(0)
 }finally{await context.close();await server.close()}
})

test('locking a batch restore waiting for commit cancels the owner without reviving sensitive DOM',async({page})=>{
 test.setTimeout(120000);const server=await startIsolatedServer()
 let release=()=>{},reached=()=>{},finished=()=>{}
 const held=new Promise<void>(resolve=>{release=resolve}),waiting=new Promise<void>(resolve=>{reached=resolve}),done=new Promise<void>(resolve=>{finished=resolve})
 try {
  await setup(page,server.baseURL,server.token);await upload(page,'one.txt');await upload(page,'two.txt');await trash(page,'one.txt');await trash(page,'two.txt');await nav(page,'回收站').click();await page.getByRole('button',{name:'全选顶层项目',exact:true}).click()
  await page.route('**/api/v1/metadata/transactions',async route=>{reached();await held;try{await route.continue()}catch{/* Owner cancelled. */}finally{finished()}})
  await page.getByRole('button',{name:'恢复所选',exact:true}).click();await waiting
  await page.getByRole('button',{name:'锁定云盘',exact:true}).click();await expect(page.getByRole('button',{name:'解锁云盘',exact:true})).toBeVisible()
  expect(await page.locator('body').innerText()).not.toMatch(/one\.txt|two\.txt/u);release();await done
  await page.getByLabel('密码',{exact:true}).fill(password);await page.getByRole('button',{name:'解锁云盘',exact:true}).click()
  await nav(page,'回收站').click();await expect(choose(page,'one.txt')).toBeVisible();await expect(choose(page,'two.txt')).toBeVisible()
  await expect.poll(()=>page.evaluate(async()=> (await (await fetch('/api/v1/storage/usage')).json()).pendingBytes)).toBe(0)
  expect(await page.evaluate(async()=> (await (await fetch('/api/v1/storage/usage')).json()).uploadReservedBytes)).toBe(0)
 }finally{release();await server.close()}
})

test('keeping both follows the restored ancestor identity instead of an unrelated same-name folder',async({page})=>{
 test.setTimeout(120000);const server=await startIsolatedServer()
 try {
  await setup(page,server.baseURL,server.token);await folder(page,'parent');await page.getByRole('button',{name:'parent',exact:true}).click();await expect(page.getByRole('heading',{name:'parent',exact:true})).toBeVisible()
  await upload(page,'child.txt');await upload(page,'sibling.txt');await trash(page,'child.txt');await nav(page,'我的文件').click();await trash(page,'parent')
  await folder(page,'parent');await page.getByRole('button',{name:'parent',exact:true}).click();await expect(page.getByRole('heading',{name:'parent',exact:true})).toBeVisible();await upload(page,'existing.txt');await nav(page,'回收站').click()
  await choose(page,'child.txt').check();await choose(page,'parent').check();await page.getByRole('button',{name:'恢复所选',exact:true}).click()
  await page.getByRole('dialog',{name:'恢复名称冲突',exact:true}).getByRole('button',{name:'保留两者并恢复',exact:true}).click();await expect(page.getByRole('heading',{name:'回收站为空',exact:true})).toBeVisible()
  await nav(page,'我的文件').click();await page.getByRole('button',{name:'parent (1)',exact:true}).click();await expect(page.getByRole('heading',{name:'parent (1)',exact:true})).toBeVisible()
  await expect(page.getByRole('button',{name:'sibling.txt',exact:true})).toBeVisible();await page.getByRole('button',{name:'child.txt',exact:true}).click();await expect(page.getByRole('dialog',{name:'预览 child.txt'})).toContainText('bytes:child.txt');await page.getByRole('button',{name:'关闭预览',exact:true}).click()
  await nav(page,'我的文件').click();await page.getByRole('button',{name:'parent',exact:true}).click();await expect(page.getByRole('heading',{name:'parent',exact:true})).toBeVisible()
  await expect(page.getByRole('button',{name:'existing.txt',exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'child.txt',exact:true})).toHaveCount(0)
 }finally{await server.close()}
})
