/**
 * This component is a breadcrumb for showing current folder path
 */
import {
  Breadcrumbs,
  Menu,
  MenuHandler,
  MenuItem,
  MenuList,
  Typography
} from '@material-tailwind/react'
import { HomeIcon } from '@heroicons/react/24/outline'
import { useState, useContext } from 'react'
import { CurPathContext } from './Contexts'

function CurPathBreadcrumbs() {
  const { curPath, setCurPath } = useContext(CurPathContext)
  const [open, setOpen] = useState(false)
  function setPathHandler(index) {
    setCurPath(curPath.slice(0, index + 1))
  }
  function renderItem(item, index) {
    return (
      <Typography key={item.id} onClick={() => setPathHandler(index)}>
        {item.name}
      </Typography>
    )
  }
  if (curPath.length <= 6) {
    return (
      <Breadcrumbs>
        {curPath.map((item, index) => {
          return index === 0 ? (
            <HomeIcon key={0} onClick={() => setPathHandler(index)} className="size-6" />
          ) : (
            renderItem(item, index)
          )
        })}
      </Breadcrumbs>
    )
  }

  return (
    <Breadcrumbs>
      <HomeIcon onClick={() => setPathHandler(0)} className="size-6" />
      {renderItem(curPath[1], 1)}
      {renderItem(curPath[2], 2)}
      <Menu placement="bottom">
        <MenuHandler onClick={() => setOpen(!open)}>
          <Typography>...</Typography>
        </MenuHandler>
        <MenuList className="max-h-96 overflow-auto">
          {curPath.slice(3, -2).map((item, index) => {
            return (
              <MenuItem key={item.id} onClick={() => setPathHandler(index + 3)}>
                {item.name}
              </MenuItem>
            )
          })}
        </MenuList>
      </Menu>
      {renderItem(curPath.at(-2), curPath.length - 2)}
      {renderItem(curPath.at(-1), curPath.length - 1)}
    </Breadcrumbs>
  )
}

export default CurPathBreadcrumbs
