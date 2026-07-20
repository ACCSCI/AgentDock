import { Toaster } from "sonner";

export function ToastContainer() {
  return (
    <Toaster
      position="bottom-right"
      closeButton
      richColors
      visibleToasts={4}
      toastOptions={{
        classNames: {
          toast: "!rounded-lg !border-border !bg-popover !text-popover-foreground !shadow-xl",
          title: "!text-sm !font-medium",
          description: "!text-xs !text-muted-foreground",
          closeButton: "!border-border !bg-background !text-foreground",
        },
      }}
    />
  );
}
