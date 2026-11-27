import { useLayoutEffect, useRef } from 'react'
import { useLocation, useNavigationType } from 'react-router-dom'

/** New pages start at their heading; filter changes, anchors and history keep their position. */
export function RouteScroll() {
  const { pathname, hash } = useLocation()
  const navigation = useNavigationType()
  const previous = useRef(pathname)
  useLayoutEffect(() => {
    if (previous.current !== pathname && navigation !== 'POP' && !hash) window.scrollTo(0, 0)
    previous.current = pathname
  }, [pathname, hash, navigation])
  return null
}
