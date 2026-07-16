/**
 * Todo-related query and mutation hooks.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./helpers.js";
import type { TodoItem } from "./types.js";

// GET todos for a project
export function useTodos(projectId: string | null) {
  return useQuery({
    queryKey: ["todos", projectId] as const,
    queryFn: async (): Promise<TodoItem[]> => {
      if (!projectId) return [];
      const todos = await api().todos.list(projectId);
      return todos.map((todo) => ({
        ...todo,
        status: todo.status as TodoItem["status"],
        order: todo.sortOrder,
      }));
    },
    enabled: !!projectId,
  });
}

// POST todos:create
export function useCreateTodo() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ projectId, content }: { projectId: string; content: string }) => {
      return api().todos.create(projectId, content);
    },
    onSuccess: (_data, { projectId }) => {
      queryClient.invalidateQueries({ queryKey: ["todos", projectId] });
    },
  });
}

// PATCH todos:cycleStatus (pending → in_progress → done → pending)
export function useCycleStatusTodo() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      await api().todos.cycleStatus(id);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["todos"] });
    },
  });
}

// PATCH todos:update (edit content)
export function useUpdateTodo() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, content }: { id: string; content: string }) => {
      await api().todos.update(id, content);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["todos"] });
    },
  });
}

// DELETE todos:delete
export function useDeleteTodo() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      await api().todos.delete(id);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["todos"] });
    },
  });
}

// PATCH todos:reorder
export function useReorderTodo() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (todoIds: string[]) => {
      await api().todos.reorder(todoIds);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["todos"] });
    },
  });
}
