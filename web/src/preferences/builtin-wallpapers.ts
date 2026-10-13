export const BUILTIN_WALLPAPERS = [
  { id: 'default', name: '默认', src: '/wallpapers/default.jpg', thumbnail: '/wallpapers/thumbs/default.jpg' },
  { id: '02', name: '赤色峡谷', src: '/wallpapers/02.jpg', thumbnail: '/wallpapers/thumbs/02.jpg' },
  { id: '03', name: '银河雪山', src: '/wallpapers/03.jpg', thumbnail: '/wallpapers/thumbs/03.jpg' },
  { id: '04', name: '日照群峰', src: '/wallpapers/04.jpg', thumbnail: '/wallpapers/thumbs/04.jpg' },
  { id: '05', name: '月下雪峰', src: '/wallpapers/05.jpg', thumbnail: '/wallpapers/thumbs/05.jpg' },
  { id: '06', name: '静谧山夜', src: '/wallpapers/06.jpg', thumbnail: '/wallpapers/thumbs/06.jpg' },
  { id: '07', name: '冰谷星空', src: '/wallpapers/07.jpg', thumbnail: '/wallpapers/thumbs/07.jpg' },
  { id: '08', name: '紫色流光', src: '/wallpapers/08.jpg', thumbnail: '/wallpapers/thumbs/08.jpg' },
] as const

export type BuiltinWallpaperId = typeof BUILTIN_WALLPAPERS[number]['id']

export function findBuiltinWallpaper(id: string | null): typeof BUILTIN_WALLPAPERS[number] | undefined {
  return BUILTIN_WALLPAPERS.find(wallpaper => wallpaper.id === id)
}
