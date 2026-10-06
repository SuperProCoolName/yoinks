import React, {useEffect, useState, type ReactNode} from 'react'
import {Box, useStdout} from 'ink'
import {useTheme} from '../theme.js'

export function FullScreen({children}: {children: ReactNode}) {
  const theme = useTheme()
  const {stdout} = useStdout()
  const dimensions = () => ({
    columns: stdout?.columns && stdout.columns > 0 ? stdout.columns : 80,
    rows: stdout?.rows && stdout.rows > 1 ? stdout.rows : 24,
  })
  const [size, setSize] = useState(dimensions)

  useEffect(() => {
    if (!stdout) return
    const onResize = () => setSize(dimensions())
    stdout.on('resize', onResize)
    return () => {
      stdout.off('resize', onResize)
    }
  }, [stdout])

  return (
    <Box
      width={size.columns}
      height={size.rows - 1}
      flexDirection="column"
      alignItems="center"
      justifyContent="center"
      backgroundColor={theme.background}
    >
      {/* single wrapper so centering leftover lands on ONE node: when the
          leftover is odd, yoga gives every direct child a *.5 y-position and
          rounds each one independently — spacer rows collapse into their
          neighbors while extra blanks open up elsewhere.
          Full width for the same reason sideways: sized to its content, the
          wrapper is as wide as its widest line, so a footer that grows by an
          odd number of cells shifts it by half a cell — rounded twice, some
          rows jumped a cell and some didn't. Against the whole screen every
          row is centered once, on its own */}
      <Box flexDirection="column" alignItems="center" flexShrink={0} width={size.columns}>
        {children}
      </Box>
    </Box>
  )
}
