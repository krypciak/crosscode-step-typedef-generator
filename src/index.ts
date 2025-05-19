import type { VarList, Function, Field } from 'crosscode-typedef-inserter'
import * as fs from 'fs'
import * as path from 'path'
import ts, { SyntaxKind } from 'typescript'

Array.prototype.last = function (this: []) {
    return this[this.length - 1]
}

export function assert(v: any, msg?: string): asserts v {
    if (!v) throw new Error(`Assertion error${msg ? `: ${msg}` : ''}`)
}

interface VarListExt extends VarList {
    settings?: Record<string, Field>
}

type TypedefRecord = Record<string, Record<string, VarList>>
type TypedefRecordExt = Record<string, Record<string, VarListExt>>

async function getNewTypes(typedefModuleRecord: TypedefRecord, gameCompiledPath: string): Promise<TypedefRecordExt> {
    function defVarList(): VarListExt {
        return {
            fields: {},
            functions: {},
            parents: [],
        }
    }

    const classPathToModule: Record<string, string> = Object.fromEntries(
        Object.entries(typedefModuleRecord).flatMap(([module, namespaces]) =>
            Object.entries(namespaces).map(([nsPath]) => [nsPath, module])
        )
    )

    const stepClasses = ['ig.EventStepBase', 'ig.ActionStepBase', 'ig.EffectStepBase'] as const
    type StepBase = (typeof stepClasses)[number]

    function getFromVarListRecursive<T extends 'functions' | 'fields'>(
        varList: VarList,
        type: T,
        name: string,
        depth = 0
    ): VarList[T][any] | undefined {
        if (depth >= 100) throw new Error('depth limit!')
        if (varList[type][name]) return varList[type][name] as any
        for (const parentPath of varList.parents) {
            if (!parentPath || parentPath == 'ig.Class' || parentPath == 'ig.Config') continue
            const module = classPathToModule[parentPath]
            if (!module) break
            const newVarList = typedefModuleRecord[module][parentPath]
            const ret = getFromVarListRecursive(newVarList, type, name, depth + 1)
            if (ret) return ret
        }
    }
    function getFunction(stepBase: StepBase, name: string): Function | undefined {
        return getFromVarListRecursive({ parents: [stepBase], fields: {}, functions: {} }, 'functions', name)
    }
    function getField(stepBase: StepBase, name: string): Field | undefined {
        return getFromVarListRecursive({ parents: [stepBase], fields: {}, functions: {} }, 'fields', name)
    }

    const program = ts.createProgram([gameCompiledPath], {
        target: ts.ScriptTarget.ES5,
        module: ts.ModuleKind.CommonJS,
        allowJs: true,
    })

    program.getTypeChecker()

    const newTypedefModuleRecord: TypedefRecordExt = {}

    const gameCompiledPathBase = path.basename(gameCompiledPath)
    for (const sourceFile of program.getSourceFiles()) {
        const baseName = path.basename(sourceFile.fileName)
        if (!baseName.startsWith(gameCompiledPathBase)) continue

        ts.forEachChild(sourceFile, node => rootVisit(node))
    }

    function rootVisit(node: ts.Node, depth: number = 0) {
        if (ts.isCallExpression(node)) {
            const expr = node.expression.getText()
            if (expr.startsWith('ig.module(') && expr.includes('defines')) {
                let baseCall: ts.Node = node.expression.getChildren()[0]
                while (true) {
                    const child = baseCall.getChildren()[0]
                    if (child.getText() != 'ig.module') {
                        baseCall = child
                    } else break
                }
                assert(ts.isCallExpression(baseCall))
                const module = baseCall.arguments.map(a => a.getText())[0].slice(1, -1)

                const syntaxList = node.getChildren().find(a => a.kind == 352)
                if (syntaxList) {
                    const func = syntaxList.getChildren()[0]
                    assert(ts.isFunctionExpression(func) || ts.isArrowFunction(func))
                    const innerSyntaxList = func.body.getChildren()[1]
                    assert(innerSyntaxList.kind == 352)
                    for (const child of innerSyntaxList.getChildren()) {
                        visit(child, module, [])
                    }
                }
            }
        }
        if (depth < 6) ts.forEachChild(node, node => rootVisit(node, depth + 1))
    }

    function visit(node: ts.Node, module: string, nsStack: string[], stepBase?: StepBase) {
        let nextVisit = true
        if (ts.isBinaryExpression(node) && node.operatorToken.kind == SyntaxKind.EqualsToken) {
            let name = node.left.getText()
            const rightText = node.right?.getChildren()?.[0]?.getText()
            if (node.right.getChildCount() == 4 && rightText.includes('extend')) {
                const extendClass = rightText.slice(0, -'.extend'.length) as StepBase
                if (stepClasses.includes(extendClass)) {
                    stepBase = extendClass
                }
                // class extend
                nsStack.push(name)
            }
        } else if (stepBase && ts.isObjectLiteralElement(node)) {
            nextVisit = false
            const name = node.name!.getText()
            const nsPath = nsStack.join('.')

            let right = node.getChildren()[2]
            if (ts.isMethodDeclaration(node)) right = node

            if (ts.isObjectLiteralExpression(right)) return

            let varList: VarListExt = typedefModuleRecord[module][nsPath]
            /* if typed then dont touch */
            if (varList) return

            newTypedefModuleRecord[module] ??= {}
            varList = newTypedefModuleRecord[module][nsPath] ??= defVarList()
            if (varList.parents.length == 0) {
                varList.parents.push(stepBase)
            }

            if (ts.isFunctionExpression(right) || ts.isMethodDeclaration(right)) {
                if (getFunction(stepBase, name)) return

                const getReturnType = () => {
                    const bodyText = right.body?.getText() ?? ''
                    const matches = [...bodyText.matchAll(/return/g)]

                    let onlyEmptyReturns = true
                    for (const match of matches) {
                        const followingChar = bodyText[match.index + 'return'.length + 1]
                        if (followingChar != '\n') onlyEmptyReturns = false
                    }
                    if (onlyEmptyReturns) return 'void'

                    return 'unknown'
                }

                const argNames = right.parameters.map(a => a.name.getText())
                const args: Function['args'] = [
                    {
                        name: 'this',
                        type: 'this',
                        isOptional: false,
                    },
                    ...argNames.map(name => ({
                        name,
                        type: 'unknown',
                        isOptional: false,
                    })),
                ]

                varList.functions[name] = {
                    returnType: getReturnType(),
                    args,
                }
            } else {
                if (getField(stepBase, name)) return

                let type = 'unknown'
                if (name == '_wm') type = stepBase == 'ig.EffectStepBase' ? 'ig.EffectConfig' : 'ig.Config'
                varList.fields[name] = { type }

                if (name == '_wm') {
                    function getAttibutes(right: ts.Node) {
                        assert(ts.isNewExpression(right))
                        assert(right.arguments)
                        const body = right.arguments[0]
                        assert(body)
                        assert(ts.isObjectLiteralExpression(body))
                        let initializer!: ts.ObjectLiteralExpression
                        for (const prop of body.properties) {
                            if (ts.isPropertyAssignment(prop) && ts.isObjectLiteralExpression(prop.initializer)) {
                                initializer = prop.initializer
                                break
                            }
                        }
                        assert(ts.isObjectLiteralExpression(initializer))
                        return initializer.properties
                    }

                    for (const attib of getAttibutes(right)) {
                        assert(ts.isPropertyAssignment(attib))
                        const name = attib.name.getText()

                        const getAttibDetails = () => {
                            assert(ts.isObjectLiteralExpression(attib.initializer))
                            const props = attib.initializer.properties

                            const findProp = (name: string, assertExists?: boolean) => {
                                const typeProp = props.find(prop => prop.name?.getText() == name)
                                if (!typeProp) {
                                    if (assertExists) assert(false)
                                    return
                                }
                                assert(ts.isPropertyAssignment(typeProp))
                                return typeProp.initializer
                            }
                            const optionalValueProp = findProp('_optional')
                            let isOptional = false
                            if (optionalValueProp) {
                                isOptional = optionalValueProp.kind == SyntaxKind.TrueKeyword
                            }

                            const typeValueProp = findProp('_type', true)!
                            assert(ts.isStringLiteral(typeValueProp))
                            const typeRaw = typeValueProp.text

                            let type: string = 'unknown'

                            if (typeRawToType[typeRaw]) type = typeRawToType[typeRaw]
                            if (type == 'unknown') {
                                console.log(nsPath, typeRaw)
                            }

                            return { type, isOptional }
                        }
                        const { type, isOptional } = getAttibDetails()
                        varList.settings ??= {}
                        varList.settings[name] = { type, isOptional }
                    }
                }
            }
        } else if (ts.isFunctionExpression(node) || ts.isArrowFunction(node)) {
            nextVisit = false
        }
        if (nextVisit) ts.forEachChild(node, node => visit(node, module, [...nsStack], stepBase))
    }

    return newTypedefModuleRecord
}

async function write(
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
                out += `      /* autogenerated step */\n`
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
                out += `          new (settings: ${nsPath}.Settings): ${stepName};\n`
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

async function run() {
    const gameCompiledPath = '/home/krypek/Programming/repos/crosscode-typedef-inserter/game.compiled.lebab.js'
    const typeInfoPath = '/home/krypek/home/Programming/repos/crosscode-typedef-inserter/typedefs.json'
    const ultimateTypedefsPath = '/home/krypek/Programming/crosscode/ultimate-crosscode-typedefs'
    const outTypedefModulesDir = './out'

    const typedefModuleRecord: TypedefRecord = JSON.parse(await fs.promises.readFile(typeInfoPath, 'utf8'))

    const newTypedefModuleRecord = await getNewTypes(typedefModuleRecord, gameCompiledPath)
    // console.dir(newTypedefModuleRecord, { depth: null })
    await write(newTypedefModuleRecord, outTypedefModulesDir, ultimateTypedefsPath)
}

await run()
