/**
 * @vitest-environment jsdom
 */

import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { Field, NumberInput, Select } from './ui'

describe('Field', () => {
  it('shows its label and its hint beside the control', () => {
    render(
      <Field label="Width" hint="Not a stock size">
        <input aria-label="Width" defaultValue="0.9" />
      </Field>,
    )
    expect(screen.getByText('Width')).toBeDefined()
    expect(screen.getByText('Not a stock size')).toBeDefined()
  })
})

describe('Select', () => {
  it('reports the value the user chose, not the one it was showing', () => {
    const onChange = vi.fn()
    render(
      <Select
        value="entry"
        onChange={onChange}
        options={[
          { value: 'entry', label: 'Way in' },
          { value: 'exit', label: 'Way out' },
        ]}
      />,
    )
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'exit' } })
    expect(onChange).toHaveBeenCalledWith('exit')
  })
})

describe('NumberInput', () => {
  const box = (onCommit: (value: number) => void) => {
    render(<NumberInput value={120} min={0} max={6000} onCommit={onCommit} />)
    return screen.getByRole('textbox') as HTMLInputElement
  }

  const typeAndLeave = (input: HTMLInputElement, text: string) => {
    fireEvent.change(input, { target: { value: text } })
    fireEvent.blur(input)
  }

  it('keeps the figure it had when the box is emptied and left', () => {
    const onCommit = vi.fn()
    const input = box(onCommit)

    typeAndLeave(input, '')

    // Selecting a headcount and hitting Delete before typing the new one is the
    // ordinary way to change it. Reading that instant as a request for zero set
    // the crowd to nobody and ran an empty venue.
    expect(onCommit).not.toHaveBeenCalled()
    expect(input.value).toBe('120')
  })

  it('refuses a figure it cannot read rather than taking what is left of it', () => {
    const onCommit = vi.fn()
    const input = box(onCommit)

    typeAndLeave(input, 'a full house')

    expect(onCommit).not.toHaveBeenCalled()
    expect(input.value).toBe('120')
  })

  it('still reads a figure written the way people write one', () => {
    const onCommit = vi.fn()
    const input = box(onCommit)

    // The field strips everything but digits and signs before parsing, and that
    // leniency is deliberate: a headcount pasted from a spreadsheet as "1,200"
    // lands, and so does a duration typed with the unit printed beside the box.
    // It is also why an emptied box ever read as zero, so the line is drawn at
    // what survives the strip — it has to contain a number. Tightening it to
    // bare digits would cost every figure written the way people write them.
    typeAndLeave(input, '1,200')
    expect(onCommit).toHaveBeenLastCalledWith(1200)

    typeAndLeave(input, '600 s')
    expect(onCommit).toHaveBeenLastCalledWith(600)
  })
})
