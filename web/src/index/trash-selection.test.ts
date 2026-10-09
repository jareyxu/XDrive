import { expect, test } from 'vitest'
import { planTrashSelection } from './trash-selection'
import type { DirectoryState, DriveEntry } from '../api/client'
import type { ZipSelection } from './zip-selection'
const file = (id: string): DriveEntry => ({ entryId: id, kind: 'file', name: id })
const folder: DriveEntry = { entryId: 'folder', kind: 'folder', name: 'tree', childIndexId: 'tree-index' }
const one = file('one'), two = file('two'), root: DirectoryState = { indexId: 'root', revision: 1, entries: [folder,one], path: [] }, tree: DirectoryState = { indexId: 'tree-index', revision: 1, entries: [two], path: [{ indexId:'root',name:'tree' }] }
const choose = (entry: DriveEntry,parent: DirectoryState): ZipSelection => ({ entry, parentIndexId: parent.indexId, parentPath: parent.path })
test('ancestor overlap produces separate roots only for disjoint selections without modifying inputs', () => {
 const parents = new Map([['root',root],['tree-index',tree]]), selected = [choose(two,tree), choose(folder,root), choose(one,root), choose(one,root)]
 const plan = planTrashSelection(selected,parents,0)
 expect(plan.roots.map(item=>item.entry.entryId)).toEqual(['folder','one']); expect(plan.changes.size).toBe(1); expect(plan.changes.get('root')).toEqual([])
 expect(root.entries).toEqual([folder,one]); expect(tree.entries).toEqual([two])
})
test('cross-parent selections are removed together and missing, inconsistent or over-capacity selections fail', () => {
 const parents = new Map([['root',root],['tree-index',tree]]), selected=[choose(one,root),choose(two,tree)]
 const plan=planTrashSelection(selected,parents,4998); expect(plan.roots).toHaveLength(2); expect(plan.changes.get('root')).toEqual([folder]); expect(plan.changes.get('tree-index')).toEqual([])
 expect(()=>planTrashSelection(selected,parents,4999)).toThrow('5000'); expect(()=>planTrashSelection([choose(file('missing'),root)],parents,0)).toThrow('重新选择')
 expect(()=>planTrashSelection([choose(one,root),choose(one,tree)],parents,0)).toThrow('不一致'); expect(()=>planTrashSelection([],parents,0)).toThrow()
})
test('499 parents fit with one trash index, 500 parents cannot split the atomic operation', () => {
 const parents = new Map<string,DirectoryState>(), selections:ZipSelection[]=[]
 for(let i=0;i<500;i++){const entry=file(`file${i}`),parent:DirectoryState={indexId:`index${i}`,revision:1,entries:[entry],path:[]};parents.set(parent.indexId,parent);selections.push(choose(entry,parent))}
 expect(planTrashSelection(selections.slice(0,499),parents,0).changes.size).toBe(499); expect(()=>planTrashSelection(selections,parents,0)).toThrow('500')
})
