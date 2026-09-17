/**
 * @vitest-environment jsdom
 */

import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { Field, Select } from './ui'

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
