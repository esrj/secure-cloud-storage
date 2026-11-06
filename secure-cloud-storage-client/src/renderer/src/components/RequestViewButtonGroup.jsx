/**
 * This component is a button group for modifying white or black list
 */
import { BookmarkSquareIcon, NoSymbolIcon } from '@heroicons/react/24/outline'
import { Button, ButtonGroup, Typography } from '@material-tailwind/react'
import WhiteListDialog from './WhiteListDialog'
import BlackListDialog from './BlackListDialog'
import { useState } from 'react'

function RequestViewButtonGroup() {
  const [whiteListOpen, setWhiteListOpen] = useState(false)
  const [blackListOpen, setBlackListOpen] = useState(false)

  return (
    <>
      <ButtonGroup variant="outlined">
        <Button
          onClick={() => setWhiteListOpen(!whiteListOpen)}
          className="flex flex-row w-24 p-2 gap-2 items-center justify-center"
        >
          <BookmarkSquareIcon className="size-4" />
          <Typography>白名單</Typography>
        </Button>
        <Button
          onClick={() => setBlackListOpen(!blackListOpen)}
          className="flex flex-row w-24 p-2 gap-2 items-center justify-center"
        >
          <NoSymbolIcon className="size-4" />
          <Typography>黑名單</Typography>
        </Button>
      </ButtonGroup>
      <WhiteListDialog open={whiteListOpen} setOpen={setWhiteListOpen} />
      <BlackListDialog open={blackListOpen} setOpen={setBlackListOpen} />
    </>
  )
}

export default RequestViewButtonGroup
