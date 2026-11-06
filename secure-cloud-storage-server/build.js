import * as esbuild from 'esbuild'

await esbuild.build({
  entryPoints: ['index.js'],
  bundle: true,
  platform: 'node',
  external: ['dtrace-provider'],
  outfile: "dist/out.js"
})