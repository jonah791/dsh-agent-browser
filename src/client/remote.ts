/**
 * 浏览器日志 client Remote（namespace 'browserLog'，与 host BrowserLogService 一致）。
 * @module dsh-agent-browser/client/remote
 */
import type { TypertRemoteContribution, TypertCodec } from '@deepseek-ai/dsh-typert-protocol'
import { z } from 'zod'

const logSchema = z.object({
  t: z.number().optional(),
  level: z.string().optional(),
  text: z.string().optional(),
})
const reportRequest: TypertCodec = { mode: 'strict', typeSymbol: 'browserLog#ReportRequest', create: () => z.object({ logs: z.array(logSchema).optional(), page: z.string().optional() }) }
const okResult: TypertCodec = { mode: 'strict', typeSymbol: 'browserLog#OkResult', create: () => z.object({ ok: z.boolean() }) }

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertRemoteNamespaceMap {
    browserLog: {
      report: (req: { logs?: Array<{ t?: number; level?: string; text?: string }>; page?: string }) => Promise<import('@deepseek-ai/dsh-typert-protocol').RemoteResult<{ ok: boolean }>>
      clear: () => Promise<import('@deepseek-ai/dsh-typert-protocol').RemoteResult<{ ok: boolean }>>
    }
  }
}

const reqParam = (codec: TypertCodec) => [{ name: 'req', wire: 'req', source: 'json', codec }] as const

export const TYPERT_REMOTE: TypertRemoteContribution = {
  package: 'dsh-agent-browser',
  descriptors: [
    { id: 'dsh-agent-browser#browserLog/report', service: 'browserLogRemote', namespace: 'browserLog', method: 'report', implementation: 'dsh-agent-browser', invocation: { kind: 'direct' }, parameters: reqParam(reportRequest), result: okResult, sourceLocation: { file: 'src/client/remote.ts', line: 1, column: 1 } },
    { id: 'dsh-agent-browser#browserLog/clear', service: 'browserLogRemote', namespace: 'browserLog', method: 'clear', implementation: 'dsh-agent-browser', invocation: { kind: 'direct' }, parameters: [], result: okResult, sourceLocation: { file: 'src/client/remote.ts', line: 1, column: 1 } },
  ],
}

export default TYPERT_REMOTE
