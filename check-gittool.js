// 验证 GitTool 是否已正确注册
import { createDefaultRegistry } from './src/tools/index.js'

const registry = createDefaultRegistry()
const tools = registry.getAll()

console.log('Available tools:')
for (const tool of tools) {
  console.log(` - ${tool.name}: ${tool.description.substring(0, 60)}...`)
}

console.log()
if (registry.has('GitTool')) {
  console.log('✅ GitTool is registered!')
  const gitTool = registry.get('GitTool')
  console.log(`   Name: ${gitTool.name}`)
  console.log(`   Actions: ${gitTool.parameters.properties.action.enum.join(', ')}`)
  console.log(`   Permission level: ${gitTool.permissionLevel}`)
} else {
  console.log('❌ GitTool NOT found')
}