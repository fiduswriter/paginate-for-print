import {PaginateForPrint} from "./paginate-for-print"

module.exports = function (configValues) {
    let paginator = new PaginateForPrint(configValues)
    paginator.initiate()
}
