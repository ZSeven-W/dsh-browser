import type { BrowserAction } from './driver-contract.js'

export interface RiskTarget {
  role: string
  name: string
  tag: string
  inputType: string
  download: boolean
}

export interface RiskDecision {
  allowed: boolean
  code: string
  reason: string
}

const destructive = /(?:\bdelete\b|\bremove\b|\berase\b|\buninstall\b|factory\s*reset|close\s+(?:my\s+)?account|terminate\s+(?:my\s+)?account|permanent(?:ly)?|删除|永久删除|移除|清空|卸载|恢复出厂|注销账号|销户)/iu
const money = /(?:\bbuy\b|\bpurchase\b|\bpay\b|checkout|place\s+order|confirm\s+order|transfer\s+(?:money|funds?)|send\s+money|subscribe|交易|购买|支付|付款|下单|结算|转账|打款|订阅)/iu
const externalCommit = /(?:\bpublish\b|\bpost\b|\bsend\b|\breply\b|\btweet\b|\bshare\b|submit\s+(?:application|review|feedback)|发布|发送|回复|发帖|提交申请|提交评价|分享)/iu
const security = /(?:change\s+password|reset\s+password|disable\s+(?:2fa|mfa)|revoke|rotate\s+(?:key|token)|修改密码|重置密码|关闭.{0,4}(?:双重|两步)验证|吊销|撤销授权)/iu
const dangerousPress = /^(?:Meta|Control)\+Enter$|^(?:Meta\+Q|Alt\+F4)$/iu

export function normalizeNavigationUrl(value: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error('navigation URL must be a non-empty string')
  if (value.length > 4096) throw new Error('navigation URL exceeds 4096 characters')
  if (value.trim() === 'about:blank') return 'about:blank'
  let parsed: URL
  try { parsed = new URL(value) } catch { throw new Error('navigation URL must be an absolute http(s) URL') }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`navigation protocol ${parsed.protocol} is not allowed`)
  }
  if (parsed.username !== '' || parsed.password !== '') throw new Error('credentials embedded in a navigation URL are not allowed')
  return parsed.href
}

/** Model flags are intentionally absent: policy is derived from the live target. */
export function classifyActionRisk(action: BrowserAction, target?: RiskTarget): RiskDecision {
  if (action.kind === 'navigate') {
    try {
      normalizeNavigationUrl(action.url)
      return { allowed: true, code: 'ALLOW_NAVIGATION', reason: 'http(s) navigation is allowed' }
    } catch (error) {
      return { allowed: false, code: 'UNSAFE_URL', reason: error instanceof Error ? error.message : String(error) }
    }
  }

  if (!target) return { allowed: false, code: 'TARGET_REQUIRED', reason: 'a live semantic target is required' }
  if (target.download) return { allowed: false, code: 'DOWNLOAD_REJECTED', reason: 'download targets are not executed by this driver' }
  if (target.inputType === 'file') return { allowed: false, code: 'FILE_UPLOAD_REJECTED', reason: 'file upload requires an explicit higher-level policy' }
  if (action.kind === 'fill' && target.inputType === 'password') {
    return { allowed: false, code: 'CREDENTIAL_ENTRY_REJECTED', reason: 'password entry is not accepted by the generic browser driver' }
  }
  if (action.kind === 'press' && dangerousPress.test(action.key.trim())) {
    return { allowed: false, code: 'DANGEROUS_KEY_REJECTED', reason: `key chord ${action.key} can commit or exit without a target-level confirmation` }
  }

  const semantics = `${target.role} ${target.name} ${target.tag}`.normalize('NFKC')
  if (destructive.test(semantics)) return { allowed: false, code: 'DESTRUCTIVE_TARGET', reason: 'target semantics indicate a destructive action' }
  if (money.test(semantics)) return { allowed: false, code: 'FINANCIAL_TARGET', reason: 'target semantics indicate a financial commitment' }
  if (externalCommit.test(semantics)) return { allowed: false, code: 'EXTERNAL_COMMIT_TARGET', reason: 'target semantics indicate sending or publishing externally' }
  if (security.test(semantics)) return { allowed: false, code: 'SECURITY_TARGET', reason: 'target semantics indicate a security-sensitive change' }
  return { allowed: true, code: 'ALLOW', reason: 'no deterministic high-risk semantics matched' }
}
