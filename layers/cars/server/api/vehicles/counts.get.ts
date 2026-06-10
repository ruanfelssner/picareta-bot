import { VehicleModel } from '../../utils/schemas/vehicle'

export default defineEventHandler(async (_event) => {
  useDb()

  const [result] = await VehicleModel.aggregate([
    { $match: { status: { $in: ['scraped', 'favorite'] } } },
    {
      $facet: {
        bySrc: [{ $group: { _id: '$source', n: { $sum: 1 } } }],
        byState: [
          { $match: { state: { $ne: null, $ne: '' } } },
          { $group: { _id: '$state', n: { $sum: 1 } } },
        ],
      },
    },
  ])

  const bySrc: Record<string, number> = {}
  for (const item of (result?.bySrc ?? []) as { _id: string; n: number }[]) {
    if (item._id) bySrc[item._id] = item.n
  }

  const byState: Record<string, number> = {}
  for (const item of (result?.byState ?? []) as { _id: string; n: number }[]) {
    if (item._id) byState[item._id] = item.n
  }

  return { bySrc, byState }
})
