import { VehicleModel } from '../../utils/schemas/vehicle'

export default defineEventHandler(async (_event) => {
  useDb()

  const largeDamageRegex = /(?:grande\s+monta|sucata|perda\s+total|irrecuper[aá]vel|recupera[cç][aã]o\s+imposs[ií]vel)/i

  const [result] = await VehicleModel.aggregate([
    {
      $match: {
        status: { $in: ['scraped', 'sent', 'favorite'] },
        $nor: [
          { damage: largeDamageRegex },
          { title: largeDamageRegex },
          { description: largeDamageRegex },
        ],
      },
    },
    {
      $facet: {
        bySrc: [{ $group: { _id: '$source', n: { $sum: 1 } } }],
        byState: [
          // Compute effective state: use state field if set, else extract 2-letter UF
          // from the end of the yard field (e.g. "Curitiba - PR" → "PR")
          {
            $addFields: {
              _effectiveState: {
                $cond: [
                  { $and: [{ $ne: ['$state', null] }, { $ne: ['$state', ''] }] },
                  { $toUpper: '$state' },
                  {
                    $let: {
                      vars: {
                        yardM: {
                          $regexFind: {
                            input: { $toUpper: { $ifNull: ['$yard', ''] } },
                            regex: '[^A-Z]([A-Z]{2})$',
                          },
                        },
                      },
                      in: { $ifNull: [{ $arrayElemAt: ['$$yardM.captures', 0] }, ''] },
                    },
                  },
                ],
              },
            },
          },
          { $match: { _effectiveState: { $ne: '' } } },
          { $group: { _id: '$_effectiveState', n: { $sum: 1 } } },
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
