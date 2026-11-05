export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface ListParams {
  page?: number;
  pageSize?: number;
  search?: string;
  sort?: string;
  order?: 'asc' | 'desc';
  filter?: Record<string, string | number | boolean | null | undefined>;
  withDeleted?: boolean;
}

export interface LoginResponse {
  accessToken: string;
  user: { id: number; username: string; firstName: string; lastName: string; role: import('./roles').UserRole; mustChangePassword: boolean };
}
