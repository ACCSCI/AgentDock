import { cn } from "@/lib/utils";
import type * as React from "react";

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "h-9 w-full min-w-0 rounded-md border border-input bg-background px-3 py-1 text-sm shadow-xs outline-none transition-[color,box-shadow,border-color] duration-(--motion-fast) placeholder:text-muted-foreground selection:bg-primary selection:text-primary-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/25 disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}

export { Input };
