import * as React from 'react';
import * as DropdownMenuPrimitive from '@radix-ui/react-dropdown-menu';
import { cn } from '@/lib/utils';

/**
 * Dropdown menu (Radix). Gives correct roving focus, arrow-key navigation,
 * Escape-to-close and focus return to the trigger for free — the pieces that are
 * easy to get subtly wrong in a hand-rolled menu (§11 "full keyboard nav").
 */
const DropdownMenu = DropdownMenuPrimitive.Root;
const DropdownMenuTrigger = DropdownMenuPrimitive.Trigger;
const DropdownMenuGroup = DropdownMenuPrimitive.Group;
const DropdownMenuPortal = DropdownMenuPrimitive.Portal;

const DropdownMenuContent = React.forwardRef<
  React.ComponentRef<typeof DropdownMenuPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Content>
>(function DropdownMenuContent({ className, sideOffset = 6, ...props }, ref) {
  return (
    <DropdownMenuPrimitive.Portal>
      <DropdownMenuPrimitive.Content
        ref={ref}
        sideOffset={sideOffset}
        className={cn(
          'z-50 min-w-[12rem] overflow-hidden rounded-md border border-line bg-paper-raised p-1',
          'shadow-[0_1px_2px_rgba(11,37,69,0.08),0_8px_24px_-12px_rgba(11,37,69,0.22)]',
          'data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95',
          'data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95',
          'duration-200 ease-out',
          className,
        )}
        {...props}
      />
    </DropdownMenuPrimitive.Portal>
  );
});

const DropdownMenuItem = React.forwardRef<
  React.ComponentRef<typeof DropdownMenuPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Item> & { destructive?: boolean }
>(function DropdownMenuItem({ className, destructive, ...props }, ref) {
  return (
    <DropdownMenuPrimitive.Item
      ref={ref}
      className={cn(
        'relative flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-[13px] outline-none',
        'transition-colors duration-150 ease-out select-none',
        'focus:bg-teal-soft focus:text-ink',
        'data-[disabled]:pointer-events-none data-[disabled]:opacity-50',
        '[&_svg]:size-3.5 [&_svg]:shrink-0 [&_svg]:text-ink-muted',
        destructive && 'text-error focus:bg-error-soft focus:text-error [&_svg]:text-error',
        className,
      )}
      {...props}
    />
  );
});

const DropdownMenuLabel = React.forwardRef<
  React.ComponentRef<typeof DropdownMenuPrimitive.Label>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Label>
>(function DropdownMenuLabel({ className, ...props }, ref) {
  return (
    <DropdownMenuPrimitive.Label
      ref={ref}
      className={cn('px-2 py-1.5 text-[11px] font-semibold tracking-wide text-ink-muted uppercase', className)}
      {...props}
    />
  );
});

const DropdownMenuSeparator = React.forwardRef<
  React.ComponentRef<typeof DropdownMenuPrimitive.Separator>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Separator>
>(function DropdownMenuSeparator({ className, ...props }, ref) {
  return <DropdownMenuPrimitive.Separator ref={ref} className={cn('-mx-1 my-1 h-px bg-line', className)} {...props} />;
});

export {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuGroup,
  DropdownMenuPortal,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
};
