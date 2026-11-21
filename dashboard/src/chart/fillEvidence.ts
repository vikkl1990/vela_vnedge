import { useQuery } from '@tanstack/react-query'
import { api } from '../api/client'
import type { TimelineMark } from '@luxalgo/vela'
import type { FillComparison } from '../../../shared/chartVerification'
export const useFillComparison = (id: number) =>
  useQuery({ queryKey: ['fill-comparison', id], queryFn: () => api.fillComparison(id), staleTime: 30000 })
export function fillComparisonMarks(data: FillComparison | undefined): TimelineMark[] {
  return (data?.fills ?? []).map((f) => {
    const text = `Recorded ${f.reason}: ${f.price}\nSaved depth: ${f.depth.price ?? 'unavailable'} · ${f.depth.status}\nTape first/VWAP: ${f.tape.first ?? 'unavailable'} / ${f.tape.vwap ?? 'unavailable'}\n${f.tape.status}\n${f.maker ?? ''}\nMarker is anchored to the recorded fill time, not the public print time.`
    return {
      id: `fill-evidence-${f.id}`,
      time: f.at,
      group: 'fill-evidence',
      title: `Fill #${f.id} · tick/depth comparison`,
      glyph: { letter: 'E', color: '#6eb6ff' },
      tooltip: text,
      content: { text },
    }
  })
}
