import type { VarList, Field } from 'crosscode-typedef-inserter/src/modules-info'
import * as fs from 'fs'
import { getNewTypes } from './type-generator'
import { write } from './type-writer'

export interface VarListExt extends VarList {
    settings?: Record<string, Field>
}

export type TypedefRecord = Record<string, Record<string, VarList>>
export type TypedefRecordExt = Record<string, Record<string, VarListExt>>

async function run() {
    const gameCompiledPath = '/home/krypek/Programming/repos/crosscode-typedef-inserter/game-compiled/game.compiled.lebab.js'
    const typeInfoPath = '/home/krypek/home/Programming/repos/crosscode-typedef-inserter/typedefs.json'
    const ultimateTypedefsPath = '/home/krypek/Programming/crosscode/ultimate-crosscode-typedefs'
    const outTypedefModulesDir = './out'

    const typedefModuleRecord: TypedefRecord = JSON.parse(await fs.promises.readFile(typeInfoPath, 'utf8'))

    const newTypedefModuleRecord = await getNewTypes(typedefModuleRecord, gameCompiledPath)
    // console.dir(newTypedefModuleRecord, { depth: null })
    await write(newTypedefModuleRecord, outTypedefModulesDir, ultimateTypedefsPath)
}

await run()
