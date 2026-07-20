import { AlertTriangle } from "lucide-react";
import { useTranslation } from "../i18n/react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "./ui/alert-dialog";

interface ConfirmDeleteModalProps {
  open: boolean;
  sessionName: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDeleteModal({
  open,
  sessionName,
  onConfirm,
  onCancel,
}: ConfirmDeleteModalProps) {
  const { t } = useTranslation("modals");
  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onCancel();
      }}
    >
      <AlertDialogContent data-testid="confirm-delete-modal">
        <AlertDialogHeader>
          <div className="flex size-9 items-center justify-center rounded-full bg-destructive/10 text-destructive">
            <AlertTriangle aria-hidden="true" className="size-4" />
          </div>
          <AlertDialogTitle>{t("confirmDelete.title")}</AlertDialogTitle>
          <AlertDialogDescription>
            {t("confirmDelete.message", { name: sessionName })}
            <br />
            {t("confirmDelete.consequence")}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel data-testid="confirm-delete-cancel">
            {t("confirmDelete.cancel")}
          </AlertDialogCancel>
          <AlertDialogAction
            className="bg-destructive text-white hover:bg-destructive/90"
            onClick={onConfirm}
            data-testid="confirm-delete-ok"
          >
            {t("confirmDelete.delete")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
