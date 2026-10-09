import type { SortBy } from '../index/entry-sort'

const columns: readonly { key: SortBy; label: string }[] = [
  { key: 'name', label: '名称' },
  { key: 'modified', label: '修改时间' },
  { key: 'size', label: '大小' },
  { key: 'type', label: '类型' },
]

interface Props {
  sortBy: SortBy
  descending: boolean
  onSort(key: SortBy): void
}

export function DriveListHeader({ sortBy, descending, onSort }: Props) {
  return <div className="drive-list-header" role="group" aria-label="文件列表列标题">
    <span aria-hidden="true" />
    <span aria-hidden="true" />
    {columns.map(({ key, label }) => <button
      key={key}
      type="button"
      data-sort-field={key}
      aria-label={`按${label}排序`}
      aria-pressed={sortBy === key}
      onClick={() => onSort(key)}
    >
      <span>{label}</span>
      <span aria-hidden="true">{sortBy === key ? descending ? ' ↓' : ' ↑' : ''}</span>
    </button>)}
    <span aria-hidden="true" />
  </div>
}
