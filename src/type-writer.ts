import { assert, type TypedefRecord, type VarListExt } from '.'
import * as fs from 'fs'

export async function write(
    newTypedefModuleRecord: TypedefRecord,
    outTypedefModulesDir: string,
    ultimateTypedefsPath: string
) {
    // await fs.promises.rm(outTypedefModulesDir, { recursive: true })
    await fs.promises.mkdir(outTypedefModulesDir, { recursive: true })

    let has = 0
    let hasnot = 0
    await Promise.all(
        Object.entries(newTypedefModuleRecord).map(([module, namespaces]) => writeModule(module, namespaces))
    )

    async function writeModule(module: string, namespaces: Record<string, VarListExt>) {
        const getComments = async () => {
            const modulePath = `${ultimateTypedefsPath}/modules/${module}.d.ts`
            const contents = await fs.promises.readFile(modulePath, 'utf8')

            if (contents.includes('export')) {
                has++
                return contents.substring(0, contents.indexOf('export')).trim()
            } else {
                hasnot++
                return contents.trim()
            }
        }

        const getStepText = async () => {
            let out = ''
            let currentNamespace = ''

            const namespacesEntries = Object.entries(namespaces)
            for (let i = 0; i < namespacesEntries.length; i++) {
                const [nsPath, varList] = namespacesEntries[i]

                const nsSplit = nsPath.split('.')
                assert(nsSplit.length == 3)
                const stepName = nsSplit[2]
                assert(varList.parents.length > 0)

                if (currentNamespace != nsSplit[1]) {
                    if (currentNamespace) out += '    }\n'
                    currentNamespace = nsSplit[1]
                    out += `    namespace ${currentNamespace} {\n`
                }
                out += `      namespace ${stepName} {\n`
                out += `        interface Settings {\n`

                for (const [fieldName, field] of Object.entries(varList.settings ?? {})) {
                    out += `          ${fieldName}${field.isOptional ? '?' : ''}: ${field.type};\n`
                }

                out += `        }\n`
                out += `      }\n`
                out += `      interface ${stepName} extends ${varList.parents.join(', ')} {\n`

                for (const [fieldName, field] of Object.entries(varList.fields)) {
                    out += `        ${fieldName}${field.isOptional ? '?' : ''}: ${field.type};\n`
                }
                if (Object.keys(varList.fields).length > 0 && Object.keys(varList.functions).length > 0)
                    out += `        \n`

                for (const [funcName, func] of Object.entries(varList.functions)) {
                    const argsStr = func.args
                        .map(arg => `${arg.name}${arg.isOptional ? '?' : ''}: ${arg.type}`)
                        .join(', ')
                    out += `        ${funcName}(${argsStr}): ${func.returnType};\n`
                }

                out += `      }\n`
                out += `      interface ${stepName}_CONSTRUCTOR extends ImpactClass<${stepName}> {\n`
                out += `          new (${varList.parents.includes('ig.EffectStepBase') ? 'sheet: ig.EffectSheet, ' : ''}settings: ${nsPath}.Settings): ${stepName};\n`
                out += `      }\n`
                out += `      var ${stepName}: ${stepName}_CONSTRUCTOR;\n`
                if (i != namespacesEntries.length - 1) out += `      \n`
            }
            if (currentNamespace) out += '    }\n'
            return out
        }

        let out: string = ''
        out += await getComments()
        out += '\n\nexport {};\n\ndeclare global {\n  namespace ig {\n'
        out += await getStepText()
        out += '  }\n}'

        const newPath = `${outTypedefModulesDir}/${module}.d.ts`
        await fs.promises.writeFile(newPath, out, 'utf8')
    }
}
