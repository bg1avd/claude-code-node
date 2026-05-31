#!/usr/bin/env node
/**
 * QQ Bot 集成测试脚本
 *
 * 使用方法：
 *  1. 配置环境变量或 ~/.claude-code/config.json
 *  2. node examples/qqbot-test.js
 */

import { QQBotEnhanced } from '../src/channel/qqbot-enhanced.js'
import { qqbotTools } from '../src/tools/qqbot-tools-wrapper.js'

async function main() {
  console.log('=== QQ Bot 集成测试 ===\n')

  // 1. 测试账户管理器（从配置加载）
  console.log('1. 测试配置加载')
  try {
    const config = {
      qqbot: {
        defaultAccount: 'default',
        accounts: {
          default: {
            enabled: true,
            appId: process.env.CC_NODE_CHANNEL_QQBOT_APPID || 'test-appid',
            clientSecret: process.env.CC_NODE_CHANNEL_QQBOT_SECRET || 'test-secret',
            dmPolicy: 'open',
            groupPolicy: 'open',
            allowFrom: ['*'],
            defaultTargets: {
              group: process.env.CC_NODE_CHANNEL_QQBOT_TARGET_GROUP || 'test-group-id'
            }
          }
        }
      }
    }

    const bot = new QQBotEnhanced(config.qqbot)
    console.log('  ✓ QQBotEnhanced 实例创建成功')
    console.log(`  - 账户数量: ${bot.accountManager.getAllAccounts().length}`)

    const account = bot.accountManager.getAccount('default')
    console.log(`  - 默认账户: ${account ? account.id : 'none'}`)
  } catch (e) {
    console.error('  ✗ 配置加载失败:', e.message)
    return
  }

  // 2. 测试工具注册
  console.log('\n2. 测试工具注册')
  try {
    console.log(`  - 注册工具数: ${qqbotTools.length}`)
    const toolNames = qqbotTools.map(t => t.name)
    console.log(`  - 工具列表: ${toolNames.join(', ')}`)
  } catch (e) {
    console.error('  ✗ 工具注册失败:', e.message)
    return
  }

  // 3. 测试 Token 获取（会实际调用 API，需要凭证）
  console.log('\n3. 测试 Token 获取')
  if (process.env.CC_NODE_CHANNEL_QQBOT_APPID && process.env.CC_NODE_CHANNEL_QQBOT_SECRET) {
    try {
      const bot = new QQBotEnhanced(config.qqbot)
      const token = await bot._getToken(bot.accountManager.getAccount('default'))
      console.log('  ✓ Token 获取成功（已隐藏）')
    } catch (e) {
      console.error('  ✗ Token 获取失败:', e.message)
    }
  } else {
    console.log('  ⚠ 未设置环境变量，跳过实际 API 调用')
  }

  // 4. 测试富媒体解析
  console.log('\n4. 测试富媒体解析')
  try {
    const { parseQQMediaTags } = await import('../src/channel/qqbot-enhanced.js')
    const testText = '这是图片：<qqmedia>/home/user/image.png</qqmedia> 这是文件：<qqmedia>/home/user/doc.pdf</qqmedia>'
    const result = parseQQMediaTags(testText)
    console.log(`  - 解析前: "${testText}"`)
    console.log(`  - 解析后: "${result.text}"`)
    console.log(`  - 媒体文件:`, result.mediaFiles)
  } catch (e) {
    console.error('  ✗ 富媒体解析失败:', e.message)
  }

  // 5. 输出配置提示
  console.log('\n5. 配置指南')
  console.log('   使用环境变量配置（最简单）:')
  console.log('   export CC_NODE_CHANNEL_QQBOT_APPID=你的AppID')
  console.log('   export CC_NODE_CHANNEL_QQBOT_SECRET=你的AppSecret')
  console.log('   export CC_NODE_CHANNEL_QQBOT_TARGET_GROUP=你的群OPENID')
  console.log('\n   或创建 ~/.claude-code/config.json（见 config-examples/qqbot-full.json）')

  console.log('\n=== 测试完成 ===')
}

main().catch(console.error)
