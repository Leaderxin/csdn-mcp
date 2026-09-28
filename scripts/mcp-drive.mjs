/**
 * 通过**真实 MCP 协议**（stdio）驱动 csdn-mcp，走一遍发布流程。
 *
 * 与 scripts/live-smoke.mjs 的区别：那个直接调用库函数，这个把服务端当成一个
 * 独立进程用 MCP 客户端连上去，用的是宿主（Hermes / Claude / Cursor）用的同一条
 * 路径 —— 协议握手、tools/list、tools/call。所以它能抓到「库本身没问题、但
 * server 装配或工具层出问题」的那一类故障。
 *
 *   CSDN_LIVE=1 node scripts/mcp-drive.mjs <mode> [markdown-file]
 *     mode = draft（默认）| publish
 *
 * Cookie 从环境变量 CSDN_COOKIE 读取，未设置时回退到 DOTENV_PATH（默认 ./.env）。
 */
import { readFileSync } from 'node:fs'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const MODE = process.argv[2] ?? 'draft'
const MD_PATH = process.argv[3] ?? './post.md'
if (process.env.CSDN_LIVE !== '1') {
  console.error('\n  CSDN_LIVE 不是 1 —— 这个脚本会真的读写线上文章，不允许误跑。')
  process.exit(2)
}

// Cookie 来自环境变量；没有时再去 .env 找（路径可用 DOTENV_PATH 覆盖）。
// 值只放进子进程环境，永不打印。
const env = { ...process.env }
if (!env.CSDN_COOKIE) {
  const dotenv = env.DOTENV_PATH ?? '.env'
  try {
    for (const line of readFileSync(dotenv, 'utf8').split('\n')) {
      const m = line.match(/^\s*CSDN_COOKIE\s*=\s*(.*)$/)
      if (m) env.CSDN_COOKIE = m[1].trim().replace(/^["']|["']$/g, '')
    }
  } catch {
    // 没有 .env 也没关系：下面统一报错
  }
}
if (!env.CSDN_COOKIE) {
  console.error('  找不到 CSDN_COOKIE：请设置环境变量，或用 DOTENV_PATH 指向含该键的 .env')
  process.exit(2)
}

const title = `80行手写Vue3 computed：从依赖收集到缓存，一次讲透（附可运行代码）`
const markdown = readFileSync(MD_PATH, 'utf8')
const description = '不从源码背书，直接从零手写一个 Vue3 computed：惰性求值、dirty 缓存、反向依赖、cleanup 四个环节各配一个真实运行输出，并给出三个最容易写错的点和与官方实现的差距。约 80 行，无依赖可运行。'

const client = new Client({ name: 'mcp-drive', version: '1.0.0' }, { capabilities: {} })
const transport = new StdioClientTransport({
  command: '/usr/local/bin/node',
  args: ['/opt/data/tools/csdn-mcp/dist/index.js'],
  env
})

const call = async (name, args = {}) => {
  const res = await client.callTool({ name, arguments: args })
  const text = (res.content ?? []).filter(c => c.type === 'text').map(c => c.text).join('\n')
  let json
  try {
    const fenced = text.match(/```json\s*([\s\S]*?)```/)
    json = fenced ? JSON.parse(fenced[1]) : undefined
  } catch {
    json = undefined
  }
  return { isError: Boolean(res.isError), text, json }
}

const step = (n, label) => console.log(`\n[${n}] ${label}`)

await client.connect(transport)
console.log('✔ MCP 握手完成')

step(1, 'tools/list —— 确认工具面')
const { tools } = await client.listTools()
console.log(`    ${tools.length} 个工具: ${tools.map(t => t.name).join(', ')}`)

step(2, 'auth_status —— 不发网络请求，先看凭证结构')
const auth = await call('auth_status')
console.log('   ', auth.text.split('\n')[0])

step(3, `publish_article（mode=${MODE}）`)
const pub = await call('publish_article', {
  title,
  markdown,
  description,
  tags: ['Vue3', 'JavaScript', '前端', '源码'],
  categories: '前端',
  mode: MODE,
  verify: true
})
console.log('    isError =', pub.isError)
console.log('   ', pub.text.split('\n')[0])
if (pub.json) console.log('    payload:', JSON.stringify(pub.json).slice(0, 400))
const articleId = pub.json?.articleId ?? pub.json?.id
if (!articleId) {
  console.error('\n  没拿到 articleId，后续步骤无法继续。原始返回：\n', pub.text.slice(0, 1500))
  await client.close()
  process.exit(1)
}
console.log('    articleId =', articleId)

step(4, `get_article(${articleId}) —— 看接口自报的原始 status`)
const got = await call('get_article', { article_id: String(articleId), include_content: false })
console.log('    isError =', got.isError)
console.log('   ', got.text.split('\n')[0])
console.log('    state =', got.json?.state, ', statusCode =', got.json?.statusCode)

step(5, `verify_article(${articleId}) —— 接口 status + 公开页 HTTP 码，两个信号`)
const ver = await call('verify_article', { article_id: String(articleId) })
console.log('    isError =', ver.isError)
console.log(ver.text)

step(6, 'list_articles(scope=all) —— 草稿是否能在后台列表里看到')
const list = await call('list_articles', { scope: 'all', page_size: 5 })
console.log('    isError =', list.isError)
console.log('   ', list.text.split('\n')[0])
console.log('    counts =', JSON.stringify(list.json?.counts))

await client.close()
console.log(`\n✔ 流程走完（mode=${MODE}）。articleId=${articleId}`)
