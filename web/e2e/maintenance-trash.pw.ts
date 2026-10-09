import { expect,test,type Page } from './legacy-list-test'
import { mkdtempSync,rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startIsolatedServer } from './isolated-server'
const password='correct horse battery'
const nav=(page:Page,name:string)=>page.getByRole('navigation',{name:'主导航'}).getByRole('button',{name,exact:true})
async function setup(page:Page,url:string,token:string){
 await page.goto(`${url}/setup#${token}`);await page.getByLabel('设置密码').fill(password);await page.getByLabel('再次输入密码').fill(password);await page.getByLabel('我已了解：如果忘记密码，云盘数据无法恢复。').check();await page.getByRole('button',{name:'创建加密云盘'}).click();await expect(page.getByRole('heading',{name:'我的文件',exact:true})).toBeVisible({timeout:30000})
}
async function upload(page:Page,name:string,size=32768){
 await page.locator('input[type="file"]:not([webkitdirectory])').first().setInputFiles({name,mimeType:'text/plain',buffer:Buffer.alloc(size,65)});await expect(page.getByRole('button',{name,exact:true})).toBeVisible();await expect(page.getByRole('status')).toContainText('上传完成。')
}
const usage=(page:Page)=>page.evaluate(async()=> (await (await fetch('/api/v1/storage/usage')).json()))
async function makeFull(page:Page,server:Awaited<ReturnType<typeof startIsolatedServer>>){
 await expect(page.getByRole('heading', { name: '\u6211\u7684\u6587\u4ef6', exact: true })).toBeVisible()
 await expect(page.getByRole('button', { name: '\u4e0a\u4f20', exact: true })).toBeEnabled()
 const before=await usage(page);expect(before.uploadReservedBytes).toBe(0);expect(before.pendingBytes).toBe(0);expect(before.trashBytes).toBe(0)
 await server.restartWithQuota(before.usedBytes+before.maintenanceReservedBytes)
 const full=await usage(page);expect(full.availableBytes).toBe(0);expect(full.usedBytes+full.reservedBytes).toBe(full.quotaBytes);expect(full.uploadReservedBytes).toBe(0)
 return full
}

test('fully live ordinary capacity can move a file to initially empty trash, replay and purge without exceeding quota',async({page})=>{
 test.setTimeout(120000);const server=await startIsolatedServer({quotaBytes:100*1024,maintenanceReserveBytes:8192}),backup=mkdtempSync(join(tmpdir(),'xdrive-trash-quota-backup-'))
 try{
  await setup(page,server.baseURL,server.token);await upload(page,'full.txt');const full=await makeFull(page,server)
  let puts=0;const keys:string[]=[],bodies:string[]=[];page.on('request',r=>{if(r.method()==='PUT')puts++})
  await page.route('**/api/v1/metadata/maintenance-trash',async route=>{
   keys.push(route.request().headers()['idempotency-key']!);bodies.push(route.request().postData()!)
   if(keys.length===1){const response=await route.fetch();expect(response.status()).toBe(200);await route.abort('failed')}else await route.continue()
  })
  page.once('dialog',d=>void d.accept());await page.getByRole('button',{name:'移到回收站 full.txt',exact:true}).click();await expect(page.getByRole('status')).toContainText('已移到回收站')
  expect(keys).toHaveLength(2);expect(new Set(keys).size).toBe(1);expect(new Set(bodies).size).toBe(1);expect(puts).toBe(0)
  const posted=JSON.parse(bodies[0]!);const added=(posted.encryptedObjects as string[]).reduce((sum,value)=>sum+Buffer.from(value,'base64').byteLength,0)
  const after=await usage(page);expect(after.usedBytes).toBe(full.usedBytes+added);expect(after.maintenanceReservedBytes).toBe(full.maintenanceReservedBytes-added);expect(after.usedBytes+after.reservedBytes).toBe(after.quotaBytes);expect(after.uploadReservedBytes).toBe(0);expect(after.pendingBytes).toBe(0)
  await nav(page,'回收站').click();await page.getByRole('button',{name:'full.txt',exact:true}).click();await expect(page.getByRole('dialog',{name:'预览 full.txt',exact:true})).toContainText('A'.repeat(1024));await page.getByRole('button',{name:'关闭预览',exact:true}).click()
  server.backupTo(backup)
  await page.getByRole('button',{name:'清空回收站',exact:true}).click();await page.getByRole('button',{name:'永久删除这 1 项',exact:true}).click();await expect(page.getByRole('heading',{name:'回收站为空',exact:true})).toBeVisible()
  const clean=await usage(page);expect(clean.usedBytes+clean.reservedBytes).toBeLessThan(clean.quotaBytes);expect(clean.uploadReservedBytes).toBe(0)
  await nav(page,'存储空间').click();await expect(page.getByRole('region',{name:'存储空间详情'})).toContainText('元数据维护预留')
 }finally{await server.close();rmSync(backup,{recursive:true,force:true})}
})

test('zero maintenance reserve refuses full-capacity trash without changing the file or quota',async({page})=>{
 test.setTimeout(120000);const server=await startIsolatedServer({quotaBytes:100*1024,maintenanceReserveBytes:0})
 try{
  await setup(page,server.baseURL,server.token);await upload(page,'kept.txt')
  const full=await makeFull(page,server);expect(full.maintenanceCapacityBytes).toBe(0);expect(full.maintenanceReservedBytes).toBe(0)
  let maintenanceCalls=0;page.on('request',request=>{if(request.url().includes('/api/v1/metadata/maintenance-trash'))maintenanceCalls++})
  page.once('dialog',dialog=>void dialog.accept());await page.getByRole('button',{name:'移到回收站 kept.txt',exact:true}).click()
  await expect(page.getByRole('alert')).toContainText('元数据维护预留不足。原项目保持原位。')
  await expect(page.getByRole('alert')).toContainText('可尝试永久清空回收站后刷新存储用量；如果预留仍不足或无法清理，请联系管理员检查维护预留配置。取消普通上传不会增加这项预留。')
  expect(maintenanceCalls).toBe(1)
  await expect(page.getByRole('button',{name:'kept.txt',exact:true})).toBeVisible()
  const after=await usage(page);expect(after.usedBytes).toBe(full.usedBytes);expect(after.reservedBytes).toBe(full.reservedBytes);expect(after.availableBytes).toBe(0);expect(after.trashBytes).toBe(0)
  await page.getByRole('button',{name:'kept.txt',exact:true}).click();await expect(page.getByRole('dialog',{name:'预览 kept.txt',exact:true})).toContainText('A'.repeat(1024))
 }finally{await server.close()}
})

test('full-capacity folder trash preserves its entire encrypted subtree and clears staged state on locking before commit',async({page})=>{
 test.setTimeout(120000);const server=await startIsolatedServer({quotaBytes:100*1024,maintenanceReserveBytes:8192})
 let release=()=>{},reached=()=>{},finished=()=>{}
 const held=new Promise<void>(resolve=>{release=resolve}),waiting=new Promise<void>(resolve=>{reached=resolve}),done=new Promise<void>(resolve=>{finished=resolve})
 try{
  await setup(page,server.baseURL,server.token);page.once('dialog',d=>void d.accept('tree'));await page.getByRole('button',{name:'新建文件夹',exact:true}).click();await page.getByRole('button',{name:'tree',exact:true}).click();await expect(page.getByRole('heading',{name:'tree',exact:true})).toBeVisible();await upload(page,'inside.txt');await nav(page,'我的文件').click();const full=await makeFull(page,server)
  await page.route('**/api/v1/metadata/maintenance-trash',async route=>{reached();await held;try{await route.continue()}catch{/* cancelled */}finally{finished()}})
  page.once('dialog',d=>void d.accept());await page.getByRole('button',{name:'移到回收站 tree',exact:true}).click();await waiting
  await page.getByRole('button',{name:'锁定云盘',exact:true}).click();await expect(page.getByRole('button',{name:'解锁云盘',exact:true})).toBeVisible();expect(await page.locator('body').innerText()).not.toMatch(/tree|inside\.txt/u)
  release();await done;await page.unroute('**/api/v1/metadata/maintenance-trash')
  await page.getByLabel('密码',{exact:true}).fill(password);await page.getByRole('button',{name:'解锁云盘',exact:true}).click();await expect(page.getByRole('button',{name:'tree',exact:true})).toBeVisible()
  const cancelled=await usage(page);expect(cancelled.usedBytes).toBe(full.usedBytes);expect(cancelled.maintenanceReservedBytes).toBe(full.maintenanceReservedBytes);expect(cancelled.uploadReservedBytes).toBe(0)
  page.once('dialog',d=>void d.accept());await page.getByRole('button',{name:'移到回收站 tree',exact:true}).click();await expect(page.getByRole('status')).toContainText('已移到回收站')
  await nav(page,'回收站').click();await page.getByRole('button',{name:'tree',exact:true}).click();await expect(page.getByRole('button',{name:'inside.txt',exact:true})).toBeVisible();await page.getByRole('button',{name:'inside.txt',exact:true}).click();await expect(page.getByRole('dialog',{name:'预览 inside.txt',exact:true})).toContainText('A'.repeat(1024))
 }finally{release();await server.close()}
})
