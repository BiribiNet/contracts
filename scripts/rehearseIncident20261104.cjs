// Compatibility entry point. The complete, fork-only flow lives in one script.
const {spawnSync}=require('node:child_process');
const path=require('node:path');
const result=spawnSync(process.execPath,[path.join(__dirname,'incident20261104.cjs'),'--fork'],{stdio:'inherit',env:process.env});
process.exitCode=result.status??1;
