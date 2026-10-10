'use client';

import { format, parseISO } from 'date-fns';
import { BarChart3, Table2 } from 'lucide-react';
import { useState } from 'react';
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from 'recharts';
import type { AdminOverviewDailyPointDto } from '@app/shared';

import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@/components/ui/chart';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';

type Metric = 'registrations' | 'sales' | 'rewardsPosted';

/**
 * Fixed metric → chart color mapping (categorical palette order, validated for CVD and contrast in
 * both themes). A metric keeps its color everywhere; text never uses it.
 */
const METRICS: ReadonlyArray<{ key: Metric; title: string; description: string; color: string }> = [
  { key: 'registrations', title: 'Registrations', description: 'New member accounts', color: 'var(--chart-1)' },
  { key: 'sales', title: 'Qualifying sales', description: 'Sales recorded (received or processed)', color: 'var(--chart-2)' },
  { key: 'rewardsPosted', title: 'Rewards posted', description: 'Rewards posted to the ledger', color: 'var(--chart-3)' },
];

const dayLabel = (date: string, pattern = 'd MMM') => format(parseISO(date), pattern);

/** Last-30-days activity as three small-multiple column charts (one series each), with a table view. */
export function ActivityCharts({ daily }: { daily: readonly AdminOverviewDailyPointDto[] }) {
  const [view, setView] = useState<'chart' | 'table'>('chart');
  return (
    <Card>
      <CardHeader>
        <CardTitle>Last 30 days</CardTitle>
        <CardDescription>Daily activity (UTC days) in your scope.</CardDescription>
        <CardAction>
          <ToggleGroup
            type="single"
            variant="outline"
            size="sm"
            value={view}
            onValueChange={(v) => v && setView(v as 'chart' | 'table')}
            aria-label="Display as"
          >
            <ToggleGroupItem value="chart" aria-label="Charts">
              <BarChart3 aria-hidden />
            </ToggleGroupItem>
            <ToggleGroupItem value="table" aria-label="Table">
              <Table2 aria-hidden />
            </ToggleGroupItem>
          </ToggleGroup>
        </CardAction>
      </CardHeader>
      <CardContent>
        {view === 'chart' ? (
          <div className="grid gap-6 md:grid-cols-3">
            {METRICS.map((m) => (
              <MetricChart key={m.key} metric={m} daily={daily} />
            ))}
          </div>
        ) : (
          <ActivityTable daily={daily} />
        )}
      </CardContent>
    </Card>
  );
}

function MetricChart({
  metric,
  daily,
}: {
  metric: (typeof METRICS)[number];
  daily: readonly AdminOverviewDailyPointDto[];
}) {
  const total = daily.reduce((sum, p) => sum + p[metric.key], 0);
  const peak = daily.reduce<AdminOverviewDailyPointDto | null>(
    (best, p) => (best === null || p[metric.key] > best[metric.key] ? p : best),
    null,
  );
  const config = { [metric.key]: { label: metric.title, color: metric.color } } satisfies ChartConfig;
  const summary =
    total === 0 || !peak
      ? `${metric.title}: none in the last 30 days.`
      : `${metric.title}: ${total.toLocaleString()} in the last 30 days, peak ${peak[metric.key].toLocaleString()} on ${dayLabel(peak.date, 'd MMMM')}.`;

  return (
    <figure className="min-w-0 space-y-2">
      <figcaption className="flex items-baseline justify-between gap-2">
        <span className="text-sm font-medium">{metric.title}</span>
        <span className="text-lg font-semibold">{total.toLocaleString()}</span>
      </figcaption>
      <p className="text-xs text-muted-foreground">{metric.description}</p>
      <ChartContainer config={config} className="aspect-auto h-36 w-full" role="img" aria-label={summary}>
        <BarChart data={[...daily]} margin={{ top: 4, right: 4, left: 0, bottom: 0 }} barCategoryGap={2} accessibilityLayer>
          <CartesianGrid vertical={false} stroke="var(--chart-grid)" />
          <XAxis
            dataKey="date"
            tickLine={false}
            axisLine={false}
            tickMargin={6}
            minTickGap={24}
            tickFormatter={(value: string) => dayLabel(value)}
          />
          <YAxis allowDecimals={false} tickLine={false} axisLine={false} width={28} tickMargin={4} />
          <ChartTooltip
            cursor={{ fill: 'var(--muted)', opacity: 0.6 }}
            content={
              <ChartTooltipContent
                indicator="line"
                labelFormatter={(_, payload) => {
                  const date = (payload?.[0]?.payload as AdminOverviewDailyPointDto | undefined)?.date;
                  return date ? dayLabel(date, 'EEE d MMM yyyy') : '';
                }}
              />
            }
          />
          <Bar dataKey={metric.key} fill={`var(--color-${metric.key})`} radius={[4, 4, 0, 0]} maxBarSize={24} />
        </BarChart>
      </ChartContainer>
    </figure>
  );
}

function ActivityTable({ daily }: { daily: readonly AdminOverviewDailyPointDto[] }) {
  const rows = [...daily].reverse();
  return (
    <div className="max-h-80 overflow-y-auto rounded-lg border">
      <Table>
        <caption className="sr-only">Daily registrations, qualifying sales and rewards posted, newest first</caption>
        <TableHeader className="sticky top-0 bg-card">
          <TableRow>
            <TableHead>Day (UTC)</TableHead>
            {METRICS.map((m) => (
              <TableHead key={m.key} className="text-right">
                {m.title}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((p) => (
            <TableRow key={p.date}>
              <TableCell>{dayLabel(p.date, 'EEE d MMM')}</TableCell>
              {METRICS.map((m) => (
                <TableCell key={m.key} className="text-right tabular-nums">
                  {p[m.key].toLocaleString()}
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
