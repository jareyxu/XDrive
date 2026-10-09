import { expect, test } from 'vitest'
import { APIError, parseAPIError, validRequestId } from './api-error'

const first = 'a123456789abcdef0123456789abcdef', second = 'b123456789abcdef0123456789abcdef'
function failure(body: unknown, header?: string, status = 507) {
  return new Response(JSON.stringify(body), { status, headers: header ? { 'X-Request-ID': header } : {} })
}
test('quota details retain the exact request ID shared by response body and header', async () => {
  const error = await parseAPIError(failure({ error: 'quota_exceeded', shortfallBytes: 36, requestId: first }, first))
  expect(error).toBeInstanceOf(APIError)
  expect(error).toMatchObject({ status: 507, code: 'quota_exceeded', shortfallBytes: 36, requestId: first })
  expect(error.message).toContain('空间配额或维护预留不足')
})
test('header-only and body-only IDs work; an absent ID does not invent one', async () => {
  expect((await parseAPIError(failure({ error: 'invalid_session' }, first))).requestId).toBe(first)
  expect((await parseAPIError(failure({ error: 'invalid_session', requestId: first }))).requestId).toBe(first)
  expect((await parseAPIError(failure({ error: 'invalid_session' }))).requestId).toBeUndefined()
})
test('mismatched or invalid response-body IDs cannot be associated with a header ID', async () => {
  for (const value of [second, 'private-filename.txt', '<script>bad</script>', first.repeat(100), null]) {
    expect((await parseAPIError(failure({ error: 'request_failed', requestId: value }, first))).requestId).toBeUndefined()
  }
})
test('non-JSON proxy errors keep a valid header but never reveal raw response text', async () => {
  const error = await parseAPIError(new Response('SQL: secret database path', { status: 502, headers: { 'X-Request-ID': first } }))
  expect(error.requestId).toBe(first)
  expect(error.message).toBe('服务器暂时出了问题，请稍后重试。')
})
test('unsafe error codes and prototype names cannot leak payloads into human messages', async () => {
  for (const code of ['SQL /private/secret.db', 'constructor', 'toString', '__proto__', 'unknown_server_error']) {
    const error = await parseAPIError(failure({ error: code }, undefined, 500))
    expect(error.message).toBe('服务器暂时出了问题，请稍后重试。')
  }
})
test('stale client protocol errors tell the user to reload the current page', async () => {
  const error = await parseAPIError(failure({ error: 'client_update_required' }, first, 426))
  expect(error.message).toContain('刷新页面')
})
test('server integrity, storage, and maintenance failures give specific recovery guidance', () => {
  expect(new APIError(400, 'object_digest_mismatch').message).toContain('重新选择原文件')
  expect(new APIError(500, 'disk_usage_unavailable').message).toContain('联系管理员')
  expect(new APIError(507, 'maintenance_reserve_exhausted').message).toContain('原项目仍在原位')
})
test('encrypted-index and tombstone-member validation messages describe request validation, not data corruption', () => {
  const encryptedIndex = new APIError(400, 'invalid_encrypted_index').message
  expect(encryptedIndex).toContain('目录密文格式无效或不受支持')
  expect(encryptedIndex).not.toContain('完整性检查')

  const member = new APIError(400, 'invalid_member').message
  expect(member).toContain('成员请求无效')
  expect(member).toContain('本次操作未提交')
  expect(member).not.toContain('项目状态无效或已变化')
})
test('metadata revision conflicts do not assume which tab or task made the competing change', () => {
  const message = new APIError(409, 'metadata_revision_conflict').message
  expect(message).toContain('内容已发生变化')
  expect(message).toContain('本次操作未提交')
  expect(message).toContain('回收站')
  expect(message).not.toContain('另一标签页')
})
test('shared object and idempotency conflicts avoid upload-only or directory-only advice', () => {
  const objectConflict = new APIError(409, 'object_conflict').message
  expect(objectConflict).toContain('本次操作未提交')
  expect(objectConflict).toContain('相关目录或传输面板')
  expect(objectConflict).not.toContain('开始新任务')

  const idempotencyConflict = new APIError(409, 'idempotency_conflict').message
  expect(idempotencyConflict).toContain('拒绝本次重复提交')
  expect(idempotencyConflict).toContain('相关目录或回收站')
  expect(idempotencyConflict).not.toContain('刷新目录查看')

  const missingTarget = new APIError(404, 'not_found').message
  expect(missingTarget).toContain('数据或操作目标不存在')
  expect(missingTarget).not.toContain('请求的页面')
})
test('unactivated pending objects do not imply a partial metadata commit', () => {
  const message = new APIError(409, 'object_not_activated').message
  expect(message).toContain('上传对象尚未就绪')
  expect(message).toContain('目录更改未提交')
  expect(message).not.toContain('部分上传数据')
})
test('upload request and integrity errors do not misattribute client metadata failures to the network', () => {
  const headers = new APIError(400, 'invalid_object_headers').message
  expect(headers).toContain('上传请求信息无效')
  expect(headers).toContain('刷新页面后重新选择原文件')
  expect(headers).not.toContain('检查网络')

  const length = new APIError(400, 'object_length_header_mismatch').message
  expect(length).toContain('声明的长度不一致')
  expect(length).toContain('文件未保存')
  expect(length).not.toContain('检查网络')

  const digest = new APIError(422, 'object_digest_mismatch').message
  expect(digest).toContain('完整性校验')
  expect(digest).toContain('提供请求编号')
  expect(digest).not.toContain('检查网络')

  const oversizedBody = new APIError(413, 'object_size_exceeded').message
  expect(oversizedBody).toContain('超出请求声明长度')
  expect(oversizedBody).not.toContain('服务器安全上限')
})
test('capacity and upload-state recovery advice matches the server failure conditions', () => {
  const reservation = new APIError(400, 'invalid_reservation').message
  expect(reservation).toContain('请求无效')
  expect(reservation).not.toContain('已失效')

  const maintenance = new APIError(507, 'maintenance_reserve_exhausted').message
  expect(maintenance).toContain('永久清空回收站')
  expect(maintenance).toContain('刷新存储用量')
  expect(maintenance).toContain('取消普通上传不会增加')

  const tooLarge = new APIError(409, 'upload_state_too_large').message
  expect(tooLarge).toContain('无法判断当前任务是否完整提交')
  expect(tooLarge).toContain('核对目标文件')

  const disk = new APIError(507, 'disk_space_low').message
  expect(disk).toContain('本次写入未完成')
  expect(disk).not.toContain('上传未开始')
  const diskUsage = new APIError(500, 'disk_usage_unavailable').message
  expect(diskUsage).toContain('存储用量信息不完整')
  expect(diskUsage).toContain('刷新存储页')
  expect(diskUsage).not.toContain('写入操作未完成')
  const object = new APIError(503, 'object_unavailable').message
  expect(object).toContain('刷新目录或传输面板核对状态')
  expect(new APIError(507, 'quota_exceeded').message).toContain('首次设置')
})
test('request validation failures are clearly rejected before submission', () => {
  const invalidRequest = new APIError(400, 'invalid_request').message
  expect(invalidRequest).toContain('请求内容无效或格式不符合要求')
  expect(invalidRequest).toContain('本次操作未提交')
  expect(invalidRequest).not.toContain('当前版本')

  const invalidKey = new APIError(400, 'invalid_idempotency_key').message
  expect(invalidKey).toContain('本次操作尚未提交')
  expect(invalidKey).not.toContain('状态无法安全确认')
})
test('setup conflicts describe retryable setup state without blaming storage failures', () => {
  const message = new APIError(409, 'setup_conflict').message
  expect(message).toContain('刷新页面查看当前状态')
  expect(message).toContain('仍显示未初始化，可重新提交')
  expect(message).not.toContain('状态已变化')
})
test('upload receive timeout explains cleanup and the resumable recovery path', async () => {
  const error = await parseAPIError(failure({ error: 'upload_receive_timeout' }, first, 408))
  expect(error).toMatchObject({ status: 408, code: 'upload_receive_timeout' })
  expect(error.message).toContain('未完成对象已清理')
  expect(error.message).toContain('传输面板')
})
test('remaining server error messages match their rejection or availability conditions', () => {
  const cases = [
    ['client_update_required', '刷新页面'],
    ['internal_error', '提供请求编号'],
    ['invalid_credentials', '用户名或密码不正确'],
    ['invalid_root_index', '云盘尚未初始化'],
    ['invalid_session', '重新登录'],
    ['invalid_trash_index', '回收站数据未通过校验'],
    ['invalid_vault_config', '云盘配置无效'],
    ['maintenance_in_progress', '此次更改未提交'],
    ['maintenance_metadata_limit', '缩小操作范围'],
    ['metadata_object_too_large', '拆分目录'],
    ['metadata_tombstoned', '返回活动目录'],
    ['method_not_allowed', '操作当前不可用'],
    ['object_receive_in_progress', '等待当前任务结束'],
    ['object_size_mismatch', '上传未完整接收'],
    ['origin_rejected', '当前打开的 XDrive 页面'],
    ['rate_limited', '尝试过于频繁'],
    ['receive_deadline_unavailable', '无法安全接收请求'],
    ['reservation_in_use', '仍有数据正在处理'],
    ['service_closing', '关闭或重启'],
    ['setup_unavailable', '设置链接可能无效、已过期或设置已完成'],
    ['storage_unavailable', '文件存储暂时不可用'],
    ['tombstone_build_unavailable', '回收站内容已变化或暂不可用'],
    ['tombstone_member_unavailable', '所选回收站内容已变化'],
    ['tombstone_overlap', '回收站所选内容重叠或已变化'],
    ['tombstone_unavailable', '回收站项目已发生变化'],
    ['upload_receive_timeout', '未完成对象已清理'],
    ['upload_state_mismatch', '上传任务状态已变化'],
    ['upload_unavailable', '上传任务不存在或已过期'],
    ['vault_config_conflict', 'Vault 配置已变化'],
    ['vault_config_invalid', 'Vault 配置无法读取'],
    ['vault_mutation_conflict', '云盘已发生变化'],
    ['vault_not_found', '尚未完成设置'],
    ['web_assets_unavailable', '页面资源暂不可用'],
  ] as const
  for (const [code, expected] of cases) {
    expect(new APIError(409, code).message, code).toContain(expected)
  }
})
test('compatibility-only server errors retain safe recovery messages', () => {
  expect(new APIError(401, 'unauthorized').message).toContain('重新登录')
  expect(new APIError(404, 'object_not_found').message).toContain('文件数据不可用')
  expect(new APIError(404, 'upload_expired').message).toContain('重新选择原文件')
  expect(new APIError(409, 'global_revision_conflict').message).toContain('刷新后重试')
})
test('invalid shortfall values and malformed JSON shapes are rejected without throwing', async () => {
  for (const value of [-1, 1.5, '1', Number.MAX_SAFE_INTEGER + 1]) {
    expect((await parseAPIError(failure({ shortfallBytes: value }))).shortfallBytes).toBeUndefined()
  }
  for (const value of [null, [], 'raw failure']) expect((await parseAPIError(failure(value))).code).toBe('request_failed')
})
test('random and entropy-failure server IDs are bounded; arbitrary tokens are rejected', () => {
  expect(validRequestId(first)).toBe(first)
  expect(validRequestId('18aff2c123-1')).toBe('18aff2c123-1')
  for (const value of ['', first.toUpperCase(), `${first}\n`, '18aff2c123-1\n', 'x'.repeat(1000), 'abcdef', undefined]) expect(validRequestId(value)).toBeUndefined()
  expect(new APIError(401, 'invalid_credentials\n').code).toBe('request_failed')
})
