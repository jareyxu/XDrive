const relativePaths = new WeakMap<object, string>()

export function associateFolderPath<T extends object>(file: T, path: string): T {
  relativePaths.set(file, path)
  return file
}

export function folderPathOf(file: object, webkitRelativePath = ''): string {
  return relativePaths.get(file) ?? webkitRelativePath
}
