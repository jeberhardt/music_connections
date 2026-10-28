import { existsSync } from 'node:fs'
import { serve } from '@hono/node-server'
import { app } from './app.ts'

if (existsSync('.env')) {
  process.loadEnvFile('.env')
}

const port = Number(process.env.PORT ?? 8787)

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`API listening on http://localhost:${info.port}`)
})
