import type { VarList, Function, Field } from 'crosscode-typedef-inserter/src/modules-info'
import type { TypedefRecord, TypedefRecordExt, VarListExt } from './index'
import { assert } from 'crosscode-typedef-inserter/src/misc'

import * as path from 'path'
import ts, { SyntaxKind } from 'typescript'
import { typeRawToType } from './type-raw-to-type'

const stepClasses = ['ig.EventStepBase', 'ig.ActionStepBase', 'ig.EffectStepBase'] as const
type StepBase = (typeof stepClasses)[number]

export async function getNewTypes(
    typedefModuleRecord: TypedefRecord,
    gameCompiledPath: string
): Promise<TypedefRecordExt> {
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

            newTypedefModuleRecord[module] ??= {}
            const varList = (newTypedefModuleRecord[module][nsPath] ??= defVarList())
            if (varList.parents.length == 0) {
                varList.parents.push(stepBase)
            }

            if (ts.isFunctionExpression(right) || ts.isMethodDeclaration(right)) {
                if (name == 'init' && varList.settings) {
                    assert(right.body)
                    const settingsVar = right.parameters?.[stepBase == 'ig.EffectStepBase' ? 1 : 0]?.getText()

                    function figureOutFieldType(
                        rest: string,
                        settingsVars: Record<string, Field>,
                        settingsTypeString: string
                    ): Field {
                        if (rest.startsWith('new sc.COMBAT_SHIELDS[')) {
                            return { type: 'sc.CombatShield' }
                        } else if (rest.startsWith('new')) {
                            const className = rest.substring('new '.length, rest.indexOf('('))
                            return { type: className }
                        } else if (rest.startsWith('ig.EffectConfig.loadParticleData')) {
                            return { type: 'ig.ParticleData' }
                        } else if (rest.startsWith('ig.bgm.loadTrack')) {
                            return { type: 'ig.BgmTrack' }
                        } else if (rest.startsWith('ig.bgm.loadTrackSet')) {
                            return { type: 'ig.BgmTrackSet' }
                        } else if (rest.startsWith('sc.ProxyTools.prepareSrc')) {
                            return { type: 'sc.ProxySpawnerBase' }
                        } else if (rest.startsWith('RegExp')) {
                            return { type: 'RegExp' }
                        } else if (rest.startsWith('KEY_SPLINES')) {
                            return { type: 'KeySpline' }
                        } else if ((rest.startsWith('ig.') || rest.startsWith('sc.')) && rest.includes('[')) {
                            const enumName = rest.substring(0, rest.indexOf('['))
                            return { type: enumName }
                        } else if (rest == settingsVar || rest == `ig.copy(${settingsVar})`) {
                            return { type: settingsTypeString }
                        } else if (settingsVar && rest.startsWith(`${settingsVar}.`)) {
                            if (rest.includes('||')) {
                                if (rest.match(/\[.+\]/) || rest.includes('(')) return { type: 'unknown' }
                                const settingsPropVarName = rest.substring(`${settingsVar}.`.length, rest.indexOf(' '))
                                const field = settingsVars[settingsPropVarName]
                                if (!field) return { type: 'unknown' }
                                const isNullable = rest.includes('|| null')
                                return { type: isNullable ? `Nullable<${field.type}>` : field.type, isOptional: false }
                            } else if (rest.includes('?')) {
                                if (rest.includes('[') || rest.includes('(')) return { type: 'unknown' }
                                const settingsPropVarName = rest.substring(`${settingsVar}.`.length, rest.indexOf(' '))
                                const field = settingsVars[settingsPropVarName]
                                return { type: field.type, isOptional: false }
                            } else {
                                if (rest.includes('==')) return { type: 'boolean' }
                                const settingsPropVarName = rest.substring(`${settingsVar}.`.length)

                                if (settingsPropVarName.includes('.')) {
                                    return { type: 'unknown' }
                                } else {
                                    const field = settingsVars[settingsPropVarName]
                                    if (!field) return { type: 'unknown' }
                                    return field
                                }
                            }
                        } else {
                            // console.log(settingsVar, rest, settingsVar)
                        }
                        return { type: 'unknown' }
                    }

                    for (const statement of right.body.statements) {
                        if (!ts.isExpressionStatement(statement)) continue
                        const text = statement.getText()
                        if (!text.startsWith('this.') || !text.includes('=')) continue

                        const thisVarName = text.substring('this.'.length, text.indexOf('=')).trim()
                        if (thisVarName.includes('.')) continue
                        const rest = text.substring(text.indexOf('=') + 1).trim()

                        const field = figureOutFieldType(rest, varList.settings, `${nsStack}.Settings`)
                        if (field.type != 'unknown') {
                            varList.fields[thisVarName] = field
                        }
                    }
                    return
                }
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
                            function findProp(node: ts.ObjectLiteralExpression, name: string, assertExists?: boolean) {
                                const typeProp = node.properties.find(prop => prop.name?.getText() == name)
                                if (!typeProp) {
                                    if (assertExists) assert(false)
                                    return
                                }
                                assert(ts.isPropertyAssignment(typeProp))
                                return typeProp.initializer
                            }

                            const initializer = attib.initializer
                            assert(ts.isObjectLiteralExpression(initializer))
                            const optionalValueProp = findProp(initializer, '_optional')
                            let isOptional = false
                            if (optionalValueProp) {
                                isOptional = optionalValueProp.kind == SyntaxKind.TrueKeyword
                            }
                            const defaultValueProp = findProp(initializer, '_default')
                            if (defaultValueProp) {
                                isOptional = true
                            }

                            const typeValueProp = findProp(initializer, '_type', true)!
                            assert(ts.isStringLiteral(typeValueProp))
                            const typeRaw = typeValueProp.text

                            let type: string = 'unknown'
                            const selectTypeProp = findProp(initializer, '_select')

                            if (typeRaw == 'Select' || selectTypeProp) {
                                if (selectTypeProp) {
                                    if (
                                        ts.isIdentifier(selectTypeProp) ||
                                        ts.isObjectLiteralExpression(selectTypeProp) ||
                                        ts.isArrayLiteralExpression(selectTypeProp)
                                    ) {
                                        type = 'unknown'
                                    } else if (ts.isStringLiteral(selectTypeProp)) {
                                        type = 'string'
                                    } else {
                                        assert(ts.isPropertyAccessExpression(selectTypeProp))
                                        const selectType = selectTypeProp.getText()
                                        type = `keyof typeof ${selectType}`
                                    }
                                }
                            } else if (typeRawToType[typeRaw]) type = typeRawToType[typeRaw]
                            else if (typeRaw == 'Array') {
                                const subValueProp = findProp(initializer, '_sub', true)!
                                if (ts.isStringLiteral(subValueProp)) {
                                    type = `${typeRawToType[subValueProp.text]}[]`
                                } else {
                                    assert(ts.isObjectLiteralExpression(subValueProp))
                                    const typeValueProp = findProp(subValueProp, '_type', true)!
                                    assert(ts.isStringLiteral(typeValueProp))
                                    type = `${typeRawToType[typeValueProp.text]}[]`
                                }
                            } else {
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
