import path from 'node:path';
import {PlatformStore,PLATFORM_FILE} from '../src/lib/data-platform/store';
import {restoreObservationBackup} from '../src/lib/data-platform/migrations/002-observation';
import {safeFile} from '../src/lib/data-platform/scanner';
const command=process.argv[2]??'plan';
try{
  if(command==='plan')console.log('PLAN：仅升级独立 platform.sqlite 到 schema 2；先 VACUUM INTO 一致性备份及 SHA-256/完整性校验，再事务建表。执行需显式 --upgrade。恢复仅 --restore-copy <backup> <new-platform.sqlite>，不会覆盖当前库。');
  else if(command==='--upgrade'){const store=new PlatformStore();try{console.log(JSON.stringify({schema:store.db.prepare('PRAGMA user_version').get()!.user_version,integrity:store.integrity(),migration:store.db.prepare('SELECT * FROM platform_migrations ORDER BY version').all()},null,2));}finally{store.close();}}
  else if(command==='--restore-copy'){
    const [backup,target]=process.argv.slice(3);if(!backup||!target||!path.isAbsolute(backup)||!path.isAbsolute(target))throw Error('恢复需要两个明确的本机绝对路径。');
    safeFile(backup);safeFile(target,false);const relative=path.relative(path.join(path.dirname(PLATFORM_FILE),'backups'),backup);if(relative.startsWith('..')||path.isAbsolute(relative))throw Error('只恢复本项目已登记的中台备份。');
    restoreObservationBackup(backup,target);console.log('PASS：已验证并恢复到全新 schema 1 副本，尚未切换服务或覆盖当前数据库。');
  }else throw Error('未知参数；默认 plan，不执行迁移。');
}catch(error){console.error(error instanceof Error?error.message:'中台迁移失败');process.exitCode=1;}
