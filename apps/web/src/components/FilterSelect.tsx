import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { createPortal } from 'react-dom';

const POPOVER_GAP = 7;
const VIEWPORT_MARGIN = 8;

interface PopoverPosition {
  left: number;
  maxHeight: number;
  placement: 'above' | 'below';
  top: number;
  width: number;
}

export function FilterSelect({
  disabled = false,
  label,
  name,
  onChange,
  options,
  value,
}: {
  disabled?: boolean;
  label: string;
  name?: string;
  onChange: (value: string) => void;
  options: ReadonlyArray<{ label: string; value: string }>;
  value: string;
}) {
  const [open, setOpen] = useState(false);
  const labelId = useId();
  const valueId = useId();
  const listboxId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [popoverPosition, setPopoverPosition] = useState<PopoverPosition | null>(null);
  const selectedIndex = Math.max(
    0,
    options.findIndex((option) => option.value === value),
  );
  const selectedOption = options[selectedIndex];

  useEffect(() => {
    if (!open) return;
    const animationFrame = window.requestAnimationFrame(() => {
      optionRefs.current[selectedIndex]?.focus();
    });
    const closeOnOutsidePointer = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!rootRef.current?.contains(target) && !popoverRef.current?.contains(target)) {
        setOpen(false);
      }
    };
    document.addEventListener('pointerdown', closeOnOutsidePointer, true);
    return () => {
      window.cancelAnimationFrame(animationFrame);
      document.removeEventListener('pointerdown', closeOnOutsidePointer, true);
    };
  }, [open, selectedIndex]);

  useLayoutEffect(() => {
    if (!open) {
      setPopoverPosition(null);
      return;
    }

    const updatePosition = () => {
      const trigger = triggerRef.current;
      const popover = popoverRef.current;
      if (!trigger || !popover) return;

      const triggerRect = trigger.getBoundingClientRect();
      const triggerOutsideViewport =
        triggerRect.bottom <= 0 ||
        triggerRect.right <= 0 ||
        triggerRect.top >= window.innerHeight ||
        triggerRect.left >= window.innerWidth;
      if (triggerOutsideViewport) {
        setOpen(false);
        return;
      }

      const width = Math.min(triggerRect.width, window.innerWidth - VIEWPORT_MARGIN * 2);
      const measuredHeight = popover.scrollHeight;
      const spaceBelow = window.innerHeight - triggerRect.bottom - POPOVER_GAP - VIEWPORT_MARGIN;
      const spaceAbove = triggerRect.top - POPOVER_GAP - VIEWPORT_MARGIN;
      const placement = measuredHeight > spaceBelow && spaceAbove > spaceBelow ? 'above' : 'below';
      const maxHeight = Math.max(0, placement === 'above' ? spaceAbove : spaceBelow);
      const visibleHeight = Math.min(measuredHeight, maxHeight);
      const top =
        placement === 'above'
          ? Math.max(VIEWPORT_MARGIN, triggerRect.top - POPOVER_GAP - visibleHeight)
          : triggerRect.bottom + POPOVER_GAP;
      const left = Math.min(
        Math.max(VIEWPORT_MARGIN, triggerRect.left),
        Math.max(VIEWPORT_MARGIN, window.innerWidth - VIEWPORT_MARGIN - width),
      );

      setPopoverPosition({ left, maxHeight, placement, top, width });
    };

    updatePosition();
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [open, options.length]);

  function moveOptionFocus(index: number, direction: 1 | -1) {
    const nextIndex = (index + direction + options.length) % options.length;
    optionRefs.current[nextIndex]?.focus();
  }

  function handleOptionKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>, index: number) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      moveOptionFocus(index, event.key === 'ArrowDown' ? 1 : -1);
      return;
    }
    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      optionRefs.current[event.key === 'Home' ? 0 : options.length - 1]?.focus();
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
    }
  }

  return (
    <div className="candidate-filter-field filter-select" ref={rootRef}>
      <span className="candidate-filter-label" id={labelId}>
        {label}
      </span>
      <button
        aria-controls={listboxId}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-labelledby={`${labelId} ${valueId}`}
        className="filter-select-trigger"
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={(event) => {
          if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
          event.preventDefault();
          setOpen(true);
        }}
        ref={triggerRef}
        type="button"
      >
        <span id={valueId}>{selectedOption?.label ?? '请选择'}</span>
        <span aria-hidden="true" className="filter-select-chevron" />
      </button>
      {name ? <input disabled={disabled} name={name} type="hidden" value={value} /> : null}
      {open
        ? createPortal(
            <div
              className="filter-select-popover"
              data-placement={popoverPosition?.placement}
              id={listboxId}
              ref={popoverRef}
              role="listbox"
              style={
                popoverPosition
                  ? {
                      left: popoverPosition.left,
                      maxHeight: popoverPosition.maxHeight,
                      top: popoverPosition.top,
                      visibility: 'visible',
                      width: popoverPosition.width,
                    }
                  : { visibility: 'hidden' }
              }
            >
              {options.map((option, index) => (
                <button
                  aria-selected={option.value === value}
                  className="filter-select-option"
                  key={option.value || 'all'}
                  onClick={() => {
                    onChange(option.value);
                    setOpen(false);
                    triggerRef.current?.focus();
                  }}
                  onKeyDown={(event) => handleOptionKeyDown(event, index)}
                  ref={(element) => {
                    optionRefs.current[index] = element;
                  }}
                  role="option"
                  type="button"
                >
                  <span>{option.label}</span>
                  <span aria-hidden="true" className="filter-select-check">
                    {option.value === value ? '✓' : ''}
                  </span>
                </button>
              ))}
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}

export function FormSelect({
  defaultValue,
  disabled = false,
  label,
  name,
  options,
}: {
  defaultValue: string;
  disabled?: boolean;
  label: string;
  name: string;
  options: ReadonlyArray<{ label: string; value: string }>;
}) {
  const [value, setValue] = useState(defaultValue);

  useEffect(() => setValue(defaultValue), [defaultValue]);

  return (
    <FilterSelect
      disabled={disabled}
      label={label}
      name={name}
      onChange={setValue}
      options={options}
      value={value}
    />
  );
}
