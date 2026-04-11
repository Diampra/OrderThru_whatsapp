import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type DashboardSummary, type MenuItem, type Order, type Review } from './lib/api';

const statusOptions = ['PENDING', 'PREPARING', 'READY', 'COMPLETED'] as const;

function formatPrice(value: string | number) {
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
  }).format(Number(value));
}

type LoginResponse = {
  accessToken: string;
  user: {
    id: string;
    email: string;
  };
};

type MenuFormState = {
  name: string;
  description: string;
  price: string;
  isAvailable: boolean;
};

const emptyMenuForm: MenuFormState = {
  name: '',
  description: '',
  price: '',
  isAvailable: true,
};

export default function App() {
  const queryClient = useQueryClient();
  const [credentials, setCredentials] = useState({
    email: '',
    password: '',
  });
  const [menuForm, setMenuForm] = useState<MenuFormState>(emptyMenuForm);
  const [editingMenuId, setEditingMenuId] = useState<string | null>(null);
  const token = window.localStorage.getItem('restaurant_admin_token');

  const loginMutation = useMutation({
    mutationFn: async () => {
      const response = await api.post<LoginResponse>('/auth/login', credentials);
      return response.data;
    },
    onSuccess: (data) => {
      window.localStorage.setItem('restaurant_admin_token', data.accessToken);
      queryClient.invalidateQueries();
      window.location.reload();
    },
  });

  const summaryQuery = useQuery({
    queryKey: ['summary'],
    queryFn: async () => (await api.get<DashboardSummary>('/dashboard/summary')).data,
    enabled: Boolean(token),
  });

  const ordersQuery = useQuery({
    queryKey: ['orders'],
    queryFn: async () => (await api.get<Order[]>('/orders')).data,
    enabled: Boolean(token),
  });

  const menuQuery = useQuery({
    queryKey: ['menu-admin'],
    queryFn: async () => (await api.get<MenuItem[]>('/menu/admin/all')).data,
    enabled: Boolean(token),
  });

  const reviewsQuery = useQuery({
    queryKey: ['reviews'],
    queryFn: async () => (await api.get<Review[]>('/reviews')).data,
    enabled: Boolean(token),
  });

  const statusMutation = useMutation({
    mutationFn: async ({ orderId, status }: { orderId: string; status: string }) =>
      api.patch(`/orders/${orderId}/status`, { status }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['orders'] });
      queryClient.invalidateQueries({ queryKey: ['summary'] });
    },
  });

  const menuMutation = useMutation({
    mutationFn: async () => {
      const payload = {
        ...menuForm,
        price: Number(menuForm.price),
      };

      if (editingMenuId) {
        await api.patch(`/menu/${editingMenuId}`, payload);
      } else {
        await api.post('/menu', payload);
      }
    },
    onSuccess: () => {
      setMenuForm(emptyMenuForm);
      setEditingMenuId(null);
      queryClient.invalidateQueries({ queryKey: ['menu-admin'] });
      queryClient.invalidateQueries({ queryKey: ['summary'] });
    },
  });

  const deleteMenuMutation = useMutation({
    mutationFn: async (menuId: string) => api.delete(`/menu/${menuId}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['menu-admin'] });
      queryClient.invalidateQueries({ queryKey: ['summary'] });
    },
  });

  if (!token) {
    return (
      <main className="flex min-h-screen items-center justify-center px-4 py-12">
        <section className="w-full max-w-5xl overflow-hidden rounded-[2rem] bg-white shadow-panel md:grid md:grid-cols-[1.2fr_0.8fr]">
          <div className="bg-ink px-8 py-10 text-white md:px-12 md:py-14">
            <p className="text-sm uppercase tracking-[0.3em] text-red-200">Restaurant Ops</p>
            <h1 className="mt-6 max-w-md font-display text-5xl leading-tight">
              Run WhatsApp orders and feedback from one calm workspace.
            </h1>
            <p className="mt-6 max-w-md text-base text-white/75">
              Track live orders, keep menu items up to date, and turn completed orders into useful
              item-level reviews.
            </p>
          </div>
          <div className="px-8 py-10 md:px-10 md:py-14">
            <h2 className="font-display text-3xl text-ink">Admin Login</h2>
            <form
              className="mt-8 space-y-4"
              onSubmit={(event) => {
                event.preventDefault();
                loginMutation.mutate();
              }}
            >
              <label className="block">
                <span className="mb-2 block text-sm text-slate-600">Email</span>
                <input
                  className="w-full rounded-2xl border border-slate-200 px-4 py-3 outline-none transition focus:border-ember"
                  type="email"
                  value={credentials.email}
                  onChange={(event) =>
                    setCredentials((current) => ({ ...current, email: event.target.value }))
                  }
                />
              </label>
              <label className="block">
                <span className="mb-2 block text-sm text-slate-600">Password</span>
                <input
                  className="w-full rounded-2xl border border-slate-200 px-4 py-3 outline-none transition focus:border-ember"
                  type="password"
                  value={credentials.password}
                  onChange={(event) =>
                    setCredentials((current) => ({ ...current, password: event.target.value }))
                  }
                />
              </label>
              <button
                className="w-full rounded-2xl bg-ember px-4 py-3 font-medium text-white transition hover:bg-red-600"
                type="submit"
                disabled={loginMutation.isPending}
              >
                {loginMutation.isPending ? 'Signing in...' : 'Sign in'}
              </button>
              {loginMutation.isError ? (
                <p className="text-sm text-red-600">Login failed. Check your credentials.</p>
              ) : null}
            </form>
          </div>
        </section>
      </main>
    );
  }

  const summary = summaryQuery.data;

  return (
    <main className="min-h-screen px-4 py-6 md:px-8">
      <div className="mx-auto max-w-7xl">
        <header className="rounded-[2rem] bg-ink px-6 py-8 text-white shadow-panel md:px-8">
          <div className="flex flex-col gap-6 md:flex-row md:items-end md:justify-between">
            <div>
              <p className="text-sm uppercase tracking-[0.3em] text-red-200">Restaurant WhatsApp MVP</p>
              <h1 className="mt-4 font-display text-4xl">Operations dashboard</h1>
              <p className="mt-3 max-w-2xl text-white/70">
                See incoming demand, update kitchen progress, and track what guests are saying about each item.
              </p>
            </div>
            <button
              className="rounded-full border border-white/20 px-5 py-3 text-sm text-white/80 transition hover:bg-white/10"
              onClick={() => {
                window.localStorage.removeItem('restaurant_admin_token');
                window.location.reload();
              }}
            >
              Logout
            </button>
          </div>
        </header>

        <section className="mt-6 grid gap-4 md:grid-cols-2 xl:grid-cols-5">
          {[
            ['Orders', summary?.ordersCount ?? 0],
            ['Pending', summary?.pendingOrdersCount ?? 0],
            ['Completed', summary?.completedOrdersCount ?? 0],
            ['Reviews', summary?.reviewsCount ?? 0],
            ['Avg rating', summary ? summary.averageRating.toFixed(1) : '0.0'],
          ].map(([label, value]) => (
            <article key={label} className="rounded-[1.5rem] bg-white p-5 shadow-panel">
              <p className="text-sm text-slate-500">{label}</p>
              <p className="mt-3 font-display text-4xl text-ink">{value}</p>
            </article>
          ))}
        </section>

        <section className="mt-6 grid gap-6 xl:grid-cols-[1.4fr_1fr]">
          <article className="rounded-[2rem] bg-white p-6 shadow-panel">
            <div>
              <h2 className="font-display text-3xl text-ink">Orders</h2>
              <p className="mt-2 text-sm text-slate-500">
                Update status to trigger customer notifications and review collection.
              </p>
            </div>
            <div className="mt-6 overflow-x-auto">
              <table className="min-w-full text-left text-sm">
                <thead className="text-slate-500">
                  <tr>
                    <th className="pb-3">Customer</th>
                    <th className="pb-3">Items</th>
                    <th className="pb-3">Amount</th>
                    <th className="pb-3">Status</th>
                    <th className="pb-3">Payment</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {ordersQuery.data?.map((order) => (
                    <tr key={order.id}>
                      <td className="py-4 pr-4">
                        <div className="font-medium text-ink">{order.customerPhone}</div>
                        <div className="text-xs text-slate-400">{order.id}</div>
                      </td>
                      <td className="py-4 pr-4">
                        {order.orderItems.map((item) => item.item.name).join(', ')}
                      </td>
                      <td className="py-4 pr-4">{formatPrice(order.totalAmount)}</td>
                      <td className="py-4 pr-4">
                        <select
                          className="rounded-xl border border-slate-200 px-3 py-2"
                          value={order.status}
                          onChange={(event) =>
                            statusMutation.mutate({ orderId: order.id, status: event.target.value })
                          }
                        >
                          {statusOptions.map((status) => (
                            <option key={status} value={status}>
                              {status}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td className="py-4">
                        {order.paymentLinkUrl ? (
                          <a className="text-ember" href={order.paymentLinkUrl} target="_blank" rel="noreferrer">
                            Open link
                          </a>
                        ) : (
                          'Pending'
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </article>

          <article className="rounded-[2rem] bg-white p-6 shadow-panel">
            <div>
              <h2 className="font-display text-3xl text-ink">Menu</h2>
              <p className="mt-2 text-sm text-slate-500">
                Keep the bot's menu current without touching code.
              </p>
            </div>
            <form
              className="mt-6 grid gap-3"
              onSubmit={(event) => {
                event.preventDefault();
                menuMutation.mutate();
              }}
            >
              <input
                className="rounded-2xl border border-slate-200 px-4 py-3"
                placeholder="Item name"
                value={menuForm.name}
                onChange={(event) => setMenuForm((current) => ({ ...current, name: event.target.value }))}
              />
              <textarea
                className="min-h-28 rounded-2xl border border-slate-200 px-4 py-3"
                placeholder="Description"
                value={menuForm.description}
                onChange={(event) =>
                  setMenuForm((current) => ({ ...current, description: event.target.value }))
                }
              />
              <input
                className="rounded-2xl border border-slate-200 px-4 py-3"
                placeholder="Price"
                value={menuForm.price}
                onChange={(event) => setMenuForm((current) => ({ ...current, price: event.target.value }))}
              />
              <label className="flex items-center gap-2 text-sm text-slate-600">
                <input
                  checked={menuForm.isAvailable}
                  type="checkbox"
                  onChange={(event) =>
                    setMenuForm((current) => ({ ...current, isAvailable: event.target.checked }))
                  }
                />
                Available
              </label>
              <button className="rounded-2xl bg-ink px-4 py-3 font-medium text-white" type="submit">
                {editingMenuId ? 'Update item' : 'Add item'}
              </button>
            </form>

            <div className="mt-6 space-y-3">
              {menuQuery.data?.map((item) => (
                <div key={item.id} className="rounded-[1.5rem] border border-slate-100 p-4">
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <p className="font-medium text-ink">{item.name}</p>
                      <p className="mt-1 text-sm text-slate-500">{item.description}</p>
                      <p className="mt-2 text-sm text-ember">{formatPrice(item.price)}</p>
                    </div>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        className="rounded-full border border-slate-200 px-3 py-2 text-xs"
                        onClick={() => {
                          setEditingMenuId(item.id);
                          setMenuForm({
                            name: item.name,
                            description: item.description,
                            price: item.price,
                            isAvailable: item.isAvailable,
                          });
                        }}
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        className="rounded-full border border-red-200 px-3 py-2 text-xs text-red-600"
                        onClick={() => deleteMenuMutation.mutate(item.id)}
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </article>
        </section>

        <section className="mt-6 rounded-[2rem] bg-white p-6 shadow-panel">
          <h2 className="font-display text-3xl text-ink">Latest reviews</h2>
          <p className="mt-2 text-sm text-slate-500">
            Use this feed to spot quality issues and menu standouts quickly.
          </p>
          <div className="mt-6 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {reviewsQuery.data?.map((review) => (
              <article key={review.id} className="rounded-[1.5rem] border border-slate-100 p-4">
                <div className="flex items-center justify-between">
                  <p className="font-medium text-ink">{review.item.name}</p>
                  <span className="rounded-full bg-orange-50 px-3 py-1 text-sm text-ember">
                    {review.rating}/5
                  </span>
                </div>
                <p className="mt-3 text-sm text-slate-600">{review.comment}</p>
                <p className="mt-4 text-xs text-slate-400">
                  {review.order.customerPhone} | {new Date(review.createdAt).toLocaleString()}
                </p>
              </article>
            ))}
          </div>
        </section>
      </div>
    </main>
  );
}
