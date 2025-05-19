import type { VarList, Function, Field } from 'crosscode-typedef-inserter'
import type { TypedefRecord, TypedefRecordExt, VarListExt } from './index'
import { assert } from './index'

import * as path from 'path'
import ts, { SyntaxKind } from 'typescript'

const typeRawToType: Record<string, string> = {
    Boolean: 'boolean',
    Number: 'number',
    Integer: 'number',
    String: 'string',
    VarName: 'string',
    EnemySearch: 'string',
    Vec3: 'Vec3',
    Offset: 'Vec3',
    Vec2: 'Vec2',
    Face: 'Vec2',
    LangLabel: 'ig.LangLabel.Data',
    StringExpression: 'ig.Event.StringExpression',
    NumberExpression: 'ig.Event.NumberExpression',
    BooleanExpression: 'ig.Event.BooleanExpression',
    Vec2Expression: 'ig.Event.Vec2Expression',
    Vec3Expression: 'ig.Event.Vec3Expression',
    NumberVary: 'ig.Event.NumberVary',
    VarCondition: 'string',
    Array: 'unknown[]',
    Quest: 'sc.QuestModel.QuestId',
    TaskIndex: 'sc.QuestModel.QuestId',
    QuestNameSelect: 'sc.QuestModel.QuestId',
    DropSelect: 'ig.Database.DropKey',
    Image: 'string',
    EffectSelect: 'string',
    CollabLabelFilter: 'string[]',
    AttackInfo: 'sc.AttackInfo.AttackSettings',
    Effect: 'ig.EffectHandle.Settings',
    ProxyRef: 'sc.ProxyTools.PrepareSrcProxySetting',
    EnemyState: 'string',
    Reaction: 'string',
    Item: 'sc.ItemID',
    Color: 'ig.RGBColorData | string',
    EnemyType: 'string',
    Timer: 'string',
    QuestResetSelect: 'string',
    GuiState: 'ig.GuiHook.State',
    NumberArray: 'number[]',
    WalkAnimConfig: 'string | ig.ActorEntity.WalkAnims',
} as const

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
